"""
Modèle de prévision de demande pour le moteur de pricing PricEye.

Ce module fournit :
- une classe `DemandModelTrainer` pour entraîner un modèle supervisé
  (XGBoost) sur le dataset construit par `build_pricing_dataset`,
- une fonction utilitaire `train_demand_model_for_property`,
- une classe `DemandPredictor` pour charger le modèle et prédire
  la demande pour un contexte donné.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np  # type: ignore
import pandas as pd  # type: ignore
from xgboost import XGBRegressor  # type: ignore

from pricing_engine.dataset_builder import build_pricing_dataset
from pricing_engine.interfaces.data_access import get_supabase_client


MODELS_DIR = Path("pricing_models")
MODELS_DIR.mkdir(exist_ok=True)


@dataclass
class DemandModelConfig:
    """
    Configuration simple pour le modèle de demande.

    Pour l’instant on expose seulement quelques hyperparamètres
    clés d’XGBoost. On peut enrichir cette config plus tard.
    """

    n_estimators: int = 300
    learning_rate: float = 0.05
    max_depth: int = 6
    subsample: float = 0.9
    colsample_bytree: float = 0.9
    random_state: int = 42


class DemandModelTrainer:
    """
    Classe responsable de l’entraînement du modèle de demande.

    Utilisation typique :
        trainer = DemandModelTrainer(property_id, config)
        df = build_pricing_dataset(...)
        trainer.fit(df)
        trainer.save_model(...)
    """

    def __init__(self, property_id: str, config: Optional[DemandModelConfig] = None) -> None:
        self.property_id = property_id
        self.config = config or DemandModelConfig()
        self.model: Optional[XGBRegressor] = None
        self.feature_columns: List[str] = []
        # Métriques d'entraînement (stockées après fit())
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
        Séparation train / validation en respectant l’ordre temporel (pas de shuffle).
        """
        df_sorted = df.sort_values("date")
        n = len(df_sorted)
        if n == 0:
            raise ValueError("Dataset vide pour l’entraînement du modèle de demande.")

        split_idx = int(n * (1 - validation_ratio))
        train_df = df_sorted.iloc[:split_idx]
        val_df = df_sorted.iloc[split_idx:]
        return train_df, val_df

    def _prepare_features_and_target(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Prépare X (features) et y (cible) à partir du dataset complet.

        Pour le MVP :
        - cible = `y_demand` (colonne déjà construite par `build_pricing_dataset`)
        - features = toutes les colonnes numériques pertinentes, hors IDs et `y_demand`.
        """
        if "y_demand" not in df.columns:
            raise ValueError("La colonne 'y_demand' est manquante dans le dataset.")

        y = df["y_demand"].astype(float)

        # Colonnes à exclure explicitement
        exclude_cols = {
            "y_demand",
            "bookings",
            "property_id",
            "room_type",
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
        # Nettoyage basique : supprimer les lignes sans y_demand
        df = df.copy()
        df = df.dropna(subset=["y_demand"])

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
            enable_categorical=False,  # Évite les problèmes avec _estimator_type
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
        
        # Stocker les métriques pour la sauvegarde ultérieure
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
        Construit le chemin de sauvegarde du modèle pour cette propriété.
        """
        return MODELS_DIR / f"demand_model_{self.property_id}.json"

    def save_model(self) -> None:
        """
        Sauvegarde le modèle entraîné (et les métadonnées) sur disque.
        """
        if self.model is None:
            raise RuntimeError("Aucun modèle entraîné à sauvegarder.")

        path = self._get_model_path()

        # On sauvegarde le modèle XGBoost au format JSON natif
        # Utiliser la méthode native de XGBoost pour éviter les problèmes avec _estimator_type
        model_json_path = str(path)
        try:
            # Essayer d'abord avec la méthode sklearn (pour compatibilité)
            self.model.save_model(model_json_path)
        except (TypeError, AttributeError) as e:
            # Si ça échoue, utiliser la méthode native XGBoost via get_booster()
            if hasattr(self.model, 'get_booster'):
                try:
                    self.model.get_booster().save_model(model_json_path)
                except Exception as e2:
                    # Dernier recours : sauvegarder via pickle
                    import pickle as pickle_module
                    pkl_path = model_json_path.replace('.json', '.pkl')
                    with open(pkl_path, 'wb') as f:
                        pickle_module.dump(self.model, f)
                    # Créer aussi un fichier JSON vide pour compatibilité
                    # Utiliser le module json importé en haut du fichier
                    with open(model_json_path, 'w') as f:
                        json.dump({"format": "pkl", "pkl_file": pkl_path}, f)
                    raise RuntimeError(
                        f"Erreur lors de la sauvegarde du modèle XGBoost: {e2}. "
                        f"Le modèle a été sauvegardé en format pickle dans {pkl_path}. "
                        "Vérifiez votre version de XGBoost."
                    ) from e2
            else:
                raise RuntimeError(
                    f"Erreur lors de la sauvegarde du modèle XGBoost: {e}. "
                    "Le modèle n'a pas de méthode get_booster(). "
                    "Vérifiez votre version de XGBoost."
                ) from e

        # Sauvegarder les méta-informations (features utilisées) dans un .meta.json
        meta = {
            "property_id": self.property_id,
            "feature_columns": self.feature_columns,
            "config": self.config.__dict__,
            "saved_at": datetime.utcnow().isoformat(),
        }
        meta_path = MODELS_DIR / f"demand_model_{self.property_id}.meta.json"
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def save_metrics(
        self,
        trained_by: str = "manual",
        model_version: str = "v1.0",
    ) -> None:
        """
        Sauvegarde les métriques d'entraînement dans la table pricing_model_metrics.

        Cette méthode ne doit pas faire échouer l'entraînement si la sauvegarde échoue.

        Paramètres :
        - trained_by: méthode d'entraînement ("manual", "batch", "auto_retrain")
        - model_version: version du modèle (ex: "v1.0", "2024-01-15")
        """
        if self.model is None:
            # Pas d'erreur, juste un warning silencieux
            return

        if (
            self.train_rmse is None
            or self.val_rmse is None
            or self.n_train_samples is None
            or self.n_val_samples is None
        ):
            # Les métriques n'ont pas été calculées (fit() n'a pas été appelé)
            return

        try:
            client = get_supabase_client()

            # Calculer l'importance des features
            feature_importance_dict = {}
            if hasattr(self.model, "feature_importances_") and len(self.feature_columns) > 0:
                importances = self.model.feature_importances_
                for i, feature_name in enumerate(self.feature_columns):
                    if i < len(importances):
                        feature_importance_dict[feature_name] = float(importances[i])

            # Chemin relatif vers le modèle
            model_path = str(self._get_model_path())

            # Préparer les métadonnées supplémentaires
            metadata = {
                "config": self.config.__dict__,
                "n_features": len(self.feature_columns),
                "feature_columns": self.feature_columns,
            }

            # Insérer dans pricing_model_metrics
            record = {
                "property_id": self.property_id,
                "model_version": model_version,
                "train_rmse": float(self.train_rmse),
                "val_rmse": float(self.val_rmse),
                "train_mae": float(self.train_mae) if self.train_mae is not None else None,
                "val_mae": float(self.val_mae) if self.val_mae is not None else None,
                "n_train_samples": int(self.n_train_samples),
                "n_val_samples": int(self.n_val_samples),
                "feature_importance": feature_importance_dict if feature_importance_dict else None,
                "model_path": model_path,
                "trained_at": datetime.utcnow().isoformat(),
                "trained_by": trained_by,
                "metadata": metadata,
            }

            response = client.table("pricing_model_metrics").insert(record).execute()

            # Vérifier si l'insertion a réussi
            if not hasattr(response, "data") or not response.data:
                # Pas d'erreur levée, juste un log silencieux
                # (on ne veut pas faire échouer l'entraînement)
                pass

        except Exception as e:
            # Ne pas faire échouer l'entraînement si la sauvegarde des métriques échoue
            # On pourrait logger l'erreur ici si nécessaire
            # import logging
            # logging.warning(f"Erreur lors de la sauvegarde des métriques: {e}")
            pass


def train_demand_model_for_property(
    property_id: str,
    start_date: str,
    end_date: str,
    config: Optional[DemandModelConfig] = None,
    trained_by: str = "manual",
    model_version: str = "v1.0",
) -> Dict[str, Any]:
    """
    Fonction utilitaire de haut niveau :
    - construit le dataset de pricing,
    - entraîne un modèle de demande,
    - sauvegarde le modèle,
    - sauvegarde les métriques dans pricing_model_metrics,
    - retourne les métriques d'entraînement.

    Paramètres :
    - property_id: ID de la propriété
    - start_date: Date de début pour le dataset
    - end_date: Date de fin pour le dataset
    - config: Configuration du modèle (optionnel)
    - trained_by: Méthode d'entraînement ("manual", "batch", "auto_retrain")
    - model_version: Version du modèle (ex: "v1.0", "2024-01-15")
    """
    df = build_pricing_dataset(property_id=property_id, start_date=start_date, end_date=end_date)

    trainer = DemandModelTrainer(property_id=property_id, config=config)
    metrics = trainer.fit(df)
    trainer.save_model()
    
    # Sauvegarder les métriques dans la base de données
    # (ne fait pas échouer l'entraînement si la sauvegarde échoue)
    trainer.save_metrics(trained_by=trained_by, model_version=model_version)

    return {
        "property_id": property_id,
        "metrics": metrics,
        "n_rows": int(len(df)),
        "date_range": {"start": start_date, "end": end_date},
    }


class DemandPredictor:
    """
    Classe pour charger un modèle de demande entraîné et faire des prédictions.
    """

    def __init__(self, property_id: str) -> None:
        self.property_id = property_id
        self.model: Optional[XGBRegressor] = None
        self.feature_columns: List[str] = []
        self._load_model()

    def _get_model_path(self) -> Path:
        return MODELS_DIR / f"demand_model_{self.property_id}.json"

    def _get_meta_path(self) -> Path:
        return MODELS_DIR / f"demand_model_{self.property_id}.meta.json"

    def _load_model(self) -> None:
        model_path = self._get_model_path()
        meta_path = self._get_meta_path()

        if not model_path.exists() or not meta_path.exists():
            raise FileNotFoundError(
                f"Modèle de demande non trouvé pour property_id={self.property_id}. "
                "Entraînez-le d’abord avec train_demand_model_for_property()."
            )

        # Vérifier si c'est un fichier pickle (fallback)
        if str(model_path).endswith('.pkl') or (model_path.exists() and model_path.stat().st_size < 100):
            # C'est probablement un fichier pickle ou un fichier JSON vide pointant vers pickle
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
        Prédit la demande à partir d’un dictionnaire de features déjà préparé.
        """
        if self.model is None:
            raise RuntimeError("Modèle de demande non chargé.")

        # Construire un DataFrame avec une seule ligne, dans l’ordre attendu des features
        X = pd.DataFrame([row], columns=self.feature_columns)
        # Remplacer les NaN éventuels par 0 pour éviter les surprises
        X = X.fillna(0)

        pred = self.model.predict(X)[0]
        # On borne la demande prédite à >= 0
        return float(max(pred, 0.0))


def predict_demand(
    property_id: str,
    room_type: Optional[str],
    date: str,
    price: Optional[float],
    context_features: Dict[str, Any],
) -> float:
    """
    Fonction de haut niveau pour prédire la demande.

    Pour le MVP, cette fonction :
    - charge le modèle pour la propriété,
    - construit un vecteur de features basique à partir :
      - du prix passé en paramètre,
      - des features marché passées dans `context_features`,
    - renvoie une prédiction de demande.

    TODO (itérations futures) :
    - reconstruire la ligne de features complète en consultant la base (`features_pricing_daily`)
      et les historiques internes pour la date donnée.
    """
    _ = room_type  # pas encore exploité dans la première version

    predictor = DemandPredictor(property_id=property_id)

    # Construire un vecteur de features minimal cohérent avec l’entraînement
    row: Dict[str, Any] = {}

    # Injecter le prix s’il fait partie des features
    if "price" in predictor.feature_columns:
        row["price"] = price if price is not None else context_features.get("price", 0.0)

    # Injecter les features marché de base si présentes
    for key in ["competitor_avg_price", "market_demand_level", "capacity"]:
        if key in predictor.feature_columns:
            row[key] = context_features.get(key, 0.0)

    # S’assurer que toutes les colonnes attendues existent dans row, même si à 0
    for col in predictor.feature_columns:
        row.setdefault(col, 0.0)

    return predictor.predict_from_row(row)



