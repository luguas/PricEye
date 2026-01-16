"""
Modèle de prévision de demande marché pour le moteur de pricing PricEye.

Ce module fournit un modèle pour les propriétés en Cold Start (sans historique).
Au lieu d'apprendre sur les bookings de la propriété, ce modèle apprend sur
la demande globale de la ville (average_market_occupancy).

Utilisation typique :
    trainer = MarketDemandModelTrainer(city, country, config)
    df = build_market_dataset(...)
    trainer.fit(df)
    trainer.save_model(...)
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np  # type: ignore
import pandas as pd  # type: ignore
from xgboost import XGBRegressor  # type: ignore

from pricing_engine.interfaces.data_access import get_supabase_client


MODELS_DIR = Path("pricing_models")
MODELS_DIR.mkdir(exist_ok=True)


@dataclass
class MarketDemandModelConfig:
    """
    Configuration pour le modèle de demande marché.
    """

    n_estimators: int = 300
    learning_rate: float = 0.05
    max_depth: int = 6
    subsample: float = 0.9
    colsample_bytree: float = 0.9
    random_state: int = 42


class MarketDemandModelTrainer:
    """
    Classe responsable de l'entraînement du modèle de demande marché.
    
    Ce modèle apprend sur market_occupancy_estimate (y) au lieu de bookings,
    en utilisant les features de market_features (X).
    """

    def __init__(
        self, 
        city: str, 
        country: str, 
        config: Optional[MarketDemandModelConfig] = None
    ) -> None:
        self.city = city
        self.country = country
        self.config = config or MarketDemandModelConfig()
        self.model: Optional[XGBRegressor] = None
        self.feature_columns: List[str] = []
        # Métriques d'entraînement
        self.train_rmse: Optional[float] = None
        self.val_rmse: Optional[float] = None
        self.train_mae: Optional[float] = None
        self.val_mae: Optional[float] = None
        self.n_train_samples: Optional[int] = None
        self.n_val_samples: Optional[int] = None

    def _split_train_validation(
        self, df: pd.DataFrame, validation_ratio: float = 0.2
    ) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        Séparation train / validation en respectant l'ordre temporel.
        """
        df_sorted = df.sort_values("date")
        n = len(df_sorted)
        if n == 0:
            raise ValueError("Dataset vide pour l'entraînement du modèle de demande marché.")

        split_idx = int(n * (1 - validation_ratio))
        train_df = df_sorted.iloc[:split_idx]
        val_df = df_sorted.iloc[split_idx:]
        return train_df, val_df

    def _prepare_features_and_target(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Prépare X (features) et y (cible) à partir du dataset.
        
        Cible : market_occupancy_estimate (average_market_occupancy)
        Features : toutes les colonnes numériques pertinentes de market_features.
        """
        if "market_occupancy_estimate" not in df.columns:
            raise ValueError("La colonne 'market_occupancy_estimate' est manquante dans le dataset.")

        y = df["market_occupancy_estimate"].astype(float)

        # Colonnes à exclure explicitement
        exclude_cols = {
            "market_occupancy_estimate",
            "id",
            "country",
            "city",
            "neighborhood",
            "property_type",
            "date",
            "currency",
            "timezone",
            "calculated_at",
            "created_at",
            "updated_at",
            "data_sources",
            "event_categories",
            "holiday_name",
            "holiday_type",
        }

        feature_cols = [c for c in df.columns if c not in exclude_cols]

        # Garder uniquement les colonnes numériques pour XGBoost
        X = df[feature_cols].select_dtypes(include=[np.number]).copy()

        self.feature_columns = list(X.columns)
        return X, y

    def fit(self, df: pd.DataFrame) -> Dict[str, float]:
        """
        Entraîne un modèle XGBoost sur le dataset fourni.
        
        Retourne un dictionnaire de métriques simples (RMSE train/val).
        """
        # Nettoyage basique : supprimer les lignes sans market_occupancy_estimate
        df = df.copy()
        df = df.dropna(subset=["market_occupancy_estimate"])

        train_df, val_df = self._split_train_validation(df)

        X_train, y_train = self._prepare_features_and_target(train_df)
        X_val, y_val = self._prepare_features_and_target(val_df)

        model = XGBRegressor(
            n_estimators=self.config.n_estimators,
            learning_rate=self.config.learning_rate,
            max_depth=self.config.max_depth,
            subsample=self.config.subsample,
            colsample_bytree=self.config.colsample_bytree,
            random_state=self.config.random_state,
            objective="reg:squarederror",
            enable_categorical=False,
        )

        model.fit(
            X_train,
            y_train,
            eval_set=[(X_val, y_val)],
            verbose=False,
        )

        # Calcul de quelques métriques simples
        from sklearn.metrics import mean_squared_error, mean_absolute_error  # type: ignore

        train_pred = model.predict(X_train)
        val_pred = model.predict(X_val)
        train_rmse = float(np.sqrt(mean_squared_error(y_train, train_pred)))
        val_rmse = float(np.sqrt(mean_squared_error(y_val, val_pred)))
        train_mae = float(mean_absolute_error(y_train, train_pred))
        val_mae = float(mean_absolute_error(y_val, val_pred))

        self.model = model
        
        # Stocker les métriques
        self.train_rmse = train_rmse
        self.val_rmse = val_rmse
        self.train_mae = train_mae
        self.val_mae = val_mae
        self.n_train_samples = len(X_train)
        self.n_val_samples = len(X_val)

        return {
            "train_rmse": train_rmse,
            "val_rmse": val_rmse,
            "train_mae": train_mae,
            "val_mae": val_mae,
        }

    def _get_model_path(self) -> Path:
        """
        Construit le chemin de sauvegarde du modèle pour cette ville/pays.
        """
        # Normaliser le nom de la ville pour le chemin de fichier
        city_safe = self.city.replace(" ", "_").replace("/", "_").lower()
        country_safe = self.country.replace(" ", "_").replace("/", "_").lower()
        return MODELS_DIR / f"market_demand_model_{country_safe}_{city_safe}.json"

    def save_model(self) -> None:
        """
        Sauvegarde le modèle entraîné (et les métadonnées) sur disque.
        """
        if self.model is None:
            raise RuntimeError("Aucun modèle entraîné à sauvegarder.")

        path = self._get_model_path()

        # Sauvegarder le modèle XGBoost au format JSON
        model_json_path = str(path)
        try:
            self.model.save_model(model_json_path)
        except (TypeError, AttributeError) as e:
            if hasattr(self.model, 'get_booster'):
                try:
                    self.model.get_booster().save_model(model_json_path)
                except Exception as e2:
                    import pickle as pickle_module
                    pkl_path = model_json_path.replace('.json', '.pkl')
                    with open(pkl_path, 'wb') as f:
                        pickle_module.dump(self.model, f)
                    with open(model_json_path, 'w') as f:
                        json.dump({"format": "pkl", "pkl_file": pkl_path}, f)
                    raise RuntimeError(
                        f"Erreur lors de la sauvegarde du modèle XGBoost: {e2}. "
                        f"Le modèle a été sauvegardé en format pickle dans {pkl_path}."
                    ) from e2
            else:
                raise RuntimeError(
                    f"Erreur lors de la sauvegarde du modèle XGBoost: {e}. "
                    "Vérifiez votre version de XGBoost."
                ) from e

        # Sauvegarder les méta-informations
        meta = {
            "city": self.city,
            "country": self.country,
            "feature_columns": self.feature_columns,
            "config": self.config.__dict__,
            "saved_at": datetime.utcnow().isoformat(),
        }
        meta_path = path.parent / f"{path.stem}.meta.json"
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")


class MarketDemandPredictor:
    """
    Classe pour charger un modèle de demande marché entraîné et faire des prédictions.
    """

    def __init__(self, city: str, country: str) -> None:
        self.city = city
        self.country = country
        self.model: Optional[XGBRegressor] = None
        self.feature_columns: List[str] = []
        self._load_model()

    def _get_model_path(self) -> Path:
        city_safe = self.city.replace(" ", "_").replace("/", "_").lower()
        country_safe = self.country.replace(" ", "_").replace("/", "_").lower()
        return MODELS_DIR / f"market_demand_model_{country_safe}_{city_safe}.json"

    def _get_meta_path(self) -> Path:
        city_safe = self.city.replace(" ", "_").replace("/", "_").lower()
        country_safe = self.country.replace(" ", "_").replace("/", "_").lower()
        return MODELS_DIR / f"market_demand_model_{country_safe}_{city_safe}.meta.json"

    def _load_model(self) -> None:
        model_path = self._get_model_path()
        meta_path = self._get_meta_path()

        if not model_path.exists() or not meta_path.exists():
            raise FileNotFoundError(
                f"Modèle de demande marché non trouvé pour city={self.city}, country={self.country}. "
                "Entraînez-le d'abord avec train_market_demand_model()."
            )

        # Vérifier si c'est un fichier pickle (fallback)
        if str(model_path).endswith('.pkl') or (model_path.exists() and model_path.stat().st_size < 100):
            import pickle
            pkl_path = model_path.parent / model_path.name.replace('.json', '.pkl')
            if pkl_path.exists():
                with open(pkl_path, 'rb') as f:
                    self.model = pickle.load(f)
            else:
                raise FileNotFoundError(f"Fichier modèle pickle non trouvé: {pkl_path}")
        else:
            # Chargement normal XGBoost
            model = XGBRegressor(enable_categorical=False)
            model.load_model(str(model_path))
            self.model = model

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.feature_columns = meta.get("feature_columns", [])

    def predict_from_row(self, row: Dict[str, Any]) -> float:
        """
        Prédit le score de demande marché à partir d'un dictionnaire de features.
        
        Retourne un score entre 0 et 100 (market_occupancy_estimate).
        """
        if self.model is None:
            raise RuntimeError("Modèle de demande marché non chargé.")

        # Construire un DataFrame avec une seule ligne, dans l'ordre attendu des features
        X = pd.DataFrame([row], columns=self.feature_columns)
        # Remplacer les NaN éventuels par 0 pour éviter les surprises
        X = X.fillna(0)

        pred = self.model.predict(X)[0]
        # On borne la prédiction entre 0 et 100 (taux d'occupation en %)
        return float(max(0.0, min(100.0, pred)))


def build_market_dataset(
    city: str,
    country: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """
    Construit le dataset pour l'entraînement du modèle de demande marché.
    
    Récupère les données de market_features pour la ville/pays donnés.
    """
    client = get_supabase_client()

    response = (
        client.table("market_features")
        .select("*")
        .eq("country", country)
        .eq("city", city)
        .gte("date", start_date)
        .lte("date", end_date)
        .order("date", desc=False)
        .execute()
    )

    if not hasattr(response, 'data'):
        raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")

    data = response.data or []
    
    if not data:
        return pd.DataFrame()

    df = pd.DataFrame(data)
    
    # S'assurer que market_occupancy_estimate existe et est numérique
    if "market_occupancy_estimate" not in df.columns:
        raise ValueError("La colonne 'market_occupancy_estimate' est manquante dans market_features.")
    
    # Convertir market_occupancy_estimate en float
    df["market_occupancy_estimate"] = pd.to_numeric(
        df["market_occupancy_estimate"], errors='coerce'
    )
    
    # Supprimer les lignes où market_occupancy_estimate est NaN
    df = df.dropna(subset=["market_occupancy_estimate"])
    
    return df


def train_market_demand_model(
    city: str,
    country: str,
    start_date: str,
    end_date: str,
    config: Optional[MarketDemandModelConfig] = None,
) -> Dict[str, Any]:
    """
    Fonction utilitaire de haut niveau pour entraîner un modèle de demande marché.
    
    Paramètres :
    - city: Ville
    - country: Pays
    - start_date: Date de début pour le dataset
    - end_date: Date de fin pour le dataset
    - config: Configuration du modèle (optionnel)
    """
    df = build_market_dataset(
        city=city,
        country=country,
        start_date=start_date,
        end_date=end_date,
    )

    if df.empty:
        raise ValueError(
            f"Aucune donnée market_features trouvée pour city={city}, country={country} "
            f"dans la plage {start_date} → {end_date}"
        )

    trainer = MarketDemandModelTrainer(city=city, country=country, config=config)
    metrics = trainer.fit(df)
    trainer.save_model()

    return {
        "city": city,
        "country": country,
        "metrics": metrics,
        "n_rows": int(len(df)),
        "date_range": {"start": start_date, "end": end_date},
    }


def predict_market_demand_score(
    city: str,
    country: str,
    date: str,
    market_features: Optional[Dict[str, Any]] = None,
) -> float:
    """
    Prédit le score de demande marché pour une date donnée.
    
    Si market_features n'est pas fourni, les récupère depuis Supabase.
    
    Retourne un score entre 0 et 100 (market_occupancy_estimate).
    """
    predictor = MarketDemandPredictor(city=city, country=country)

    # Si market_features n'est pas fourni, les récupérer depuis Supabase
    if market_features is None:
        client = get_supabase_client()
        response = (
            client.table("market_features")
            .select("*")
            .eq("country", country)
            .eq("city", city)
            .eq("date", date)
            .maybe_single()
            .execute()
        )
        
        if not hasattr(response, 'data') or not response.data:
            raise ValueError(
                f"Aucune donnée market_features trouvée pour city={city}, "
                f"country={country}, date={date}"
            )
        
        market_features = response.data

    # Construire un vecteur de features cohérent avec l'entraînement
    row: Dict[str, Any] = {}

    # Injecter toutes les features numériques disponibles
    for col in predictor.feature_columns:
        if col in market_features:
            value = market_features[col]
            # Convertir en float si possible
            try:
                row[col] = float(value) if value is not None else 0.0
            except (TypeError, ValueError):
                row[col] = 0.0
        else:
            row[col] = 0.0

    return predictor.predict_from_row(row)


def predict_market_demand_scores_next_30_days(
    city: str,
    country: str,
    start_date: Optional[str] = None,
) -> Dict[str, float]:
    """
    Prédit les scores de demande marché pour les 30 prochains jours.
    
    Paramètres :
    - city: Ville
    - country: Pays
    - start_date: Date de début (par défaut: aujourd'hui)
    
    Retourne un dictionnaire {date: score} pour les 30 prochains jours.
    """
    if start_date is None:
        start_date = datetime.now().date().isoformat()

    predictor = MarketDemandPredictor(city=city, country=country)
    client = get_supabase_client()
    
    scores: Dict[str, float] = {}
    
    # Pour chaque jour des 30 prochains jours
    current_date = datetime.strptime(start_date, "%Y-%m-%d").date()
    for i in range(30):
        date_str = (current_date + timedelta(days=i)).isoformat()
        
        # Récupérer les market_features pour cette date
        try:
            response = (
                client.table("market_features")
                .select("*")
                .eq("country", country)
                .eq("city", city)
                .eq("date", date_str)
                .maybe_single()
                .execute()
            )
            
            if hasattr(response, 'data') and response.data:
                market_features = response.data
                score = predictor.predict_from_row(
                    {col: float(market_features.get(col, 0.0)) if market_features.get(col) is not None else 0.0
                     for col in predictor.feature_columns}
                )
                scores[date_str] = score
            else:
                # Si pas de données, utiliser une valeur par défaut (50%)
                scores[date_str] = 50.0
        except Exception as e:
            # En cas d'erreur, utiliser une valeur par défaut
            print(f"Warning: Erreur lors de la prédiction pour {date_str}: {e}")
            scores[date_str] = 50.0
    
    return scores
