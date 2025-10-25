// Importer les modules nécessaires
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();
const cron = require('node-cron');

// Configuration Firebase (nécessaire pour la clé API web)
const firebaseConfig = {
    apiKey: "AIzaSyCqdbT96st3gc9bQ9A4Yk7uxU-Dfuzyiuc",
    authDomain: "priceye-6f81a.firebaseapp.com",
    databaseURL: "https://priceye-6f81a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "priceye-6f81a",
    storageBucket: "priceye-6f81a.appspot.com",
    messagingSenderId: "244431363759",
    appId: "1:244431363759:web:c2f600581f341fbca63e5a",
    measurementId: "G-QC6JW8HXBE"
};

// --- INITIALISATION DE FIREBASE ADMIN ---
try {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
    console.log('Connecté à Firebase avec succès.');
} catch (error) {
    console.error('Erreur d\'initialisation de Firebase Admin:', error);
    process.exit(1);
}

const app = express();
const port = process.env.PORT || 5000;

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// --- MIDDLEWARE D'AUTHENTIFICATION ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Accès non autorisé. Jeton manquant.' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Erreur de vérification du jeton:', error);
        res.status(403).send({ error: 'Jeton invalide ou expiré.' });
    }
};


// --- ROUTES D'AUTHENTIFICATION (PUBLIQUES) ---
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name, currency, language, timezone } = req.body;

    if (!email || !password) {
        return res.status(400).send({ error: 'Email et mot de passe sont requis.' });
    }

    try {
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
        });

        const db = admin.firestore();
        await db.collection('users').doc(userRecord.uid).set({
            email: email,
            name: name || 'Nouvel Utilisateur',
            currency: currency || 'EUR',
            language: language || 'fr',
            timezone: timezone || 'Europe/Paris',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            notificationPreferences: {
                notifyOnBooking: true,
                notifyOnApiError: true,
            },
            reportFrequency: 'hebdomadaire',
            teamId: userRecord.uid,
            role: 'admin'
        });

        res.status(201).send({
            message: 'Utilisateur créé et profil enregistré avec succès',
            uid: userRecord.uid
        });
    } catch (error) {
        console.error('Erreur lors de la création de l\'utilisateur ou du profil:', error);
        if (error.code === 'auth/email-already-exists') {
            return res.status(409).send({ error: 'Cette adresse e-mail est déjà utilisée.' });
        }
        if (error.code === 'auth/invalid-password') {
            return res.status(400).send({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
        }
        res.status(500).send({ error: 'Erreur interne du serveur lors de la création de l\'utilisateur.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).send({ error: 'Email et mot de passe sont requis.' });
    }
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
        });
        const data = await response.json();
        if (!response.ok) {
            const errorMessage = data.error?.message || 'Erreur inconnue de Firebase.';
            switch (errorMessage) {
                case 'INVALID_LOGIN_CREDENTIALS':
                    return res.status(401).send({ error: 'Email ou mot de passe invalide.' });
                case 'EMAIL_NOT_FOUND':
                    return res.status(404).send({ error: 'Aucun compte trouvé pour cet e-mail.' });
                default:
                    return res.status(400).send({ error: `Erreur d'authentification: ${errorMessage}` });
            }
        }
        res.status(200).send({ message: 'Connexion réussie', idToken: data.idToken });
    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la connexion.' });
    }
});


// --- ROUTES DE GESTION DU PROFIL UTILISATEUR (SÉCURISÉES) ---
app.get('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (!doc.exists) {
            console.warn(`Profil Firestore manquant pour l'utilisateur ${userId}. Tentative de création.`);
            await userRef.set({
                email: req.user.email,
                name: 'Utilisateur existant',
                currency: 'EUR', language: 'fr', timezone: 'Europe/Paris',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                notificationPreferences: { notifyOnBooking: true, notifyOnApiError: true },
                reportFrequency: 'hebdomadaire',
                teamId: userId, role: 'admin'
            });
            const newDoc = await userRef.get();
            return res.status(200).json(newDoc.data());
        }
        res.status(200).json(doc.data());
    } catch (error) {
        console.error('Erreur lors de la récupération du profil:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération du profil.' });
    }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const incomingData = req.body;

        const allowedFields = [
            'name',
            'currency',
            'language',
            'timezone',
            'notificationPreferences',
            'reportFrequency'
        ];

        const dataToUpdate = {};
        Object.keys(incomingData).forEach(key => {
            if (allowedFields.includes(key)) {
                if (key === 'notificationPreferences') {
                    if (typeof incomingData[key] === 'object' && incomingData[key] !== null) {
                        dataToUpdate[key] = {
                            notifyOnBooking: typeof incomingData[key].notifyOnBooking === 'boolean' ? incomingData[key].notifyOnBooking : true,
                            notifyOnApiError: typeof incomingData[key].notifyOnApiError === 'boolean' ? incomingData[key].notifyOnApiError : true
                        };
                    }
                } else if (key === 'reportFrequency') {
                    const allowedFrequencies = ['jamais', 'quotidien', 'hebdomadaire', 'mensuel'];
                    if (allowedFrequencies.includes(incomingData[key])) {
                        dataToUpdate[key] = incomingData[key];
                    }
                } else {
                    dataToUpdate[key] = incomingData[key];
                }
            }
        });

        if (Object.keys(dataToUpdate).length === 0) {
            return res.status(400).send({ error: 'Aucun champ valide à mettre à jour.' });
        }

        const userRef = db.collection('users').doc(userId);
        await userRef.update(dataToUpdate);
        res.status(200).send({ message: 'Profil mis à jour avec succès' });
    } catch (error) {
        console.error('Erreur lors de la mise à jour du profil:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour du profil.' });
    }
});


// --- ROUTES DE L'API POUR LES PROPRIÉTÉS (SÉCURISÉES) ---
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            console.warn(`Utilisateur ${userId} n'a pas de teamId, fallback sur ownerId.`);
            const propertiesSnapshot = await db.collection('properties').where('ownerId', '==', userId).get();
            const properties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return res.status(200).json(properties);
        }
        const teamId = userProfileDoc.data().teamId;

        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();

        const properties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(properties);
    } catch (error) {
        console.error('Erreur lors de la récupération des propriétés:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des propriétés.' });
    }
});

app.post('/api/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const newPropertyData = req.body;
        const userId = req.user.uid;
        if (!newPropertyData || !newPropertyData.address || !newPropertyData.location) {
            return res.status(400).send({ error: 'Les données fournies sont incomplètes.' });
        }
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const teamId = userProfileDoc.exists ? userProfileDoc.data().teamId : userId;

        const propertyWithOwner = {
            ...newPropertyData,
            ownerId: userId,
            teamId: teamId,
            amenities: newPropertyData.amenities || [],
            strategy: newPropertyData.strategy || 'Équilibré',
            floor_price: newPropertyData.floor_price || 0,
            base_price: newPropertyData.base_price || 100,
            ceiling_price: newPropertyData.ceiling_price || null,
            min_stay: newPropertyData.min_stay || 1,
            max_stay: newPropertyData.max_stay || null,
            weekly_discount_percent: newPropertyData.weekly_discount_percent || null,
            monthly_discount_percent: newPropertyData.monthly_discount_percent || null,
            weekend_markup_percent: newPropertyData.weekend_markup_percent || null
        };
        const docRef = await db.collection('properties').add(propertyWithOwner);
        res.status(201).send({ message: 'Propriété ajoutée avec succès', id: docRef.id });
    } catch (error) {
        console.error('Erreur lors de l\'ajout de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de l\'ajout de la propriété.' });
    }
});

app.put('/api/properties/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const updatedData = req.body;

        const propertyRef = db.collection('properties').doc(propertyId);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
            return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        await propertyRef.update(updatedData);
        res.status(200).send({ message: 'Propriété mise à jour avec succès', id: propertyId });
    } catch (error) {
        console.error('Erreur lors de la mise à jour de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la propriété.' });
    }
});

app.delete('/api/properties/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const propertyRef = db.collection('properties').doc(propertyId);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée (rôle admin requis).' });
        }

        await propertyRef.delete();
        res.status(200).send({ message: 'Propriété supprimée avec succès', id: propertyId });
    } catch (error) {
        console.error('Erreur lors de la suppression de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de la suppression de la propriété.' });
    }
});

app.put('/api/properties/:id/strategy', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const { strategy, floor_price, base_price, ceiling_price } = req.body;

        const allowedStrategies = ['Prudent', 'Équilibré', 'Agressif'];
        if (!strategy || !allowedStrategies.includes(strategy)) {
            return res.status(400).send({ error: 'Stratégie invalide ou manquante.' });
        }
        const floorPriceNum = Number(floor_price);
        const basePriceNum = Number(base_price);
        const ceilingPriceNum = ceiling_price != null ? Number(ceiling_price) : null;

        if (isNaN(floorPriceNum) || floorPriceNum < 0 || isNaN(basePriceNum) || basePriceNum < 0) {
            return res.status(400).send({ error: 'Prix plancher et de base sont requis et doivent être des nombres positifs.' });
        }
        if (floorPriceNum > basePriceNum) {
            return res.status(400).send({ error: 'Le prix plancher ne peut pas être supérieur au prix de base.' });
        }
        if (ceiling_price != null && (isNaN(ceilingPriceNum) || ceilingPriceNum < basePriceNum)) {
            return res.status(400).send({ error: 'Prix plafond doit être un nombre valide et supérieur ou égal au prix de base.' });
        }

        const propertyRef = db.collection('properties').doc(id);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
            return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        const strategyData = {
            strategy,
            floor_price: floorPriceNum,
            base_price: basePriceNum,
            ceiling_price: ceilingPriceNum,
        };

        await propertyRef.update(strategyData);
        res.status(200).send({ message: 'Stratégie de prix mise à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la mise à jour de la stratégie:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la stratégie.' });
    }
});

app.put('/api/properties/:id/rules', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const {
            min_stay,
            max_stay,
            weekly_discount_percent,
            monthly_discount_percent,
            weekend_markup_percent
        } = req.body;

        const rulesData = {};
        const parseNumericOrNull = (value, min = 0, max = Infinity) => {
            if (value == null || value === '') return null;
            const num = Number(value);
            return !isNaN(num) && num >= min && num <= max ? num : null;
        };

        rulesData.min_stay = parseNumericOrNull(min_stay, 1);
        rulesData.max_stay = parseNumericOrNull(max_stay, rulesData.min_stay || 1);
        rulesData.weekly_discount_percent = parseNumericOrNull(weekly_discount_percent, 0, 100);
        rulesData.monthly_discount_percent = parseNumericOrNull(monthly_discount_percent, 0, 100);
        rulesData.weekend_markup_percent = parseNumericOrNull(weekend_markup_percent, 0);

        const cleanRulesData = Object.entries(rulesData)
            .filter(([_, value]) => value !== null)
            .reduce((obj, [key, value]) => {
                obj[key] = value;
                return obj;
            }, {});

        if (Object.keys(cleanRulesData).length === 0) {
            return res.status(200).send({ message: 'Aucune règle valide fournie, aucune mise à jour effectuée.' });
        }

        const propertyRef = db.collection('properties').doc(id);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
            return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        await propertyRef.update(cleanRulesData);
        res.status(200).send({ message: 'Règles personnalisées mises à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la mise à jour des règles:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles.' });
    }
});

// POST /api/properties/:id/bookings - Ajouter une réservation
app.post('/api/properties/:id/bookings', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate, pricePerNight, totalPrice, channel, guestName, numberOfGuests } = req.body;

        if (!startDate || !endDate || typeof pricePerNight !== 'number' || pricePerNight <= 0) {
            return res.status(400).send({ error: 'Dates de début/fin et prix par nuit valides sont requis.' });
        }

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        const nights = Math.round((end - start) / (1000 * 60 * 60 * 24));
        if (nights <= 0) {
            return res.status(400).send({ error: 'La date de fin doit être après la date de début.' });
        }

        const newBooking = {
            startDate,
            endDate,
            pricePerNight,
            totalPrice: totalPrice || pricePerNight * nights,
            channel: channel || 'Direct',
            bookedAt: admin.firestore.FieldValue.serverTimestamp(),
            teamId: propertyTeamId,
            ...(guestName && { guestName }),
            ...(numberOfGuests && typeof numberOfGuests === 'number' && { numberOfGuests }),
        };

        const bookingRef = await propertyRef.collection('reservations').add(newBooking);

        res.status(201).send({ message: 'Réservation ajoutée avec succès.', bookingId: bookingRef.id });

    } catch (error) {
        console.error('Erreur lors de l\'ajout de la réservation:', error);
        res.status(500).send({ error: 'Erreur serveur lors de l\'ajout de la réservation.' });
    }
});

// GET /api/properties/:id/bookings - Récupérer les réservations pour un mois donné
app.get('/api/properties/:id/bookings', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { year, month } = req.query;

        const yearNum = parseInt(year);
        const monthNum = parseInt(month); // Attend 1-12
        if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
            return res.status(400).send({ error: 'Année et mois (1-12) valides sont requis.' });
        }

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const startOfMonth = `${yearNum}-${String(monthNum).padStart(2, '0')}-01`;
        const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
        const nextYear = monthNum === 12 ? yearNum + 1 : yearNum;
        const startOfNextMonth = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

        const bookingsCol = propertyRef.collection('reservations');

        const q = bookingsCol
            .where("startDate", "<", startOfNextMonth)
            .where("endDate", ">", startOfMonth);

        const snapshot = await q.get();

        const bookings = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.status(200).json(bookings);

    } catch (error) {
        if (error.message && error.message.includes('requires an index')) {
            console.error('ERREUR FIRESTORE - Index manquant :', error.message);
        } else {
            console.error('Erreur lors de la récupération des réservations:', error);
        }
        res.status(500).send({ error: 'Erreur serveur lors de la récupération des réservations. Vérifiez les logs du serveur pour plus de détails.' });
    }
});


// --- ROUTES DE GESTION DES GROUPES (SÉCURISÉES) ---
app.post('/api/groups', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { name } = req.body;
        const userId = req.user.uid;
        if (!name) {
            return res.status(400).send({ error: 'Le nom du groupe est requis.' });
        }
        const newGroup = {
            name,
            ownerId: userId,
            properties: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            syncPrices: false // Ajout du champ pour la synchro
        };
        const docRef = await db.collection('groups').add(newGroup);
        res.status(201).send({ message: 'Groupe créé avec succès', id: docRef.id });
    } catch (error) {
        console.error('Erreur lors de la création du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la création du groupe.' });
    }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get();
        const groups = groupsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(groups);
    } catch (error) {
        console.error('Erreur lors de la récupération des groupes:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des groupes.' });
    }
});

app.put('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { name, syncPrices, mainPropertyId } = req.body; // Accepter 'name', 'syncPrices', 'mainPropertyId'
        const userId = req.user.uid;

        const groupRef = db.collection('groups').doc(id);
        const doc = await groupRef.get();

        if (!doc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }

        if (doc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        // Préparer les données à mettre à jour
        const dataToUpdate = {};
        if (name) {
            dataToUpdate.name = name;
        }
        if (syncPrices != null && typeof syncPrices === 'boolean') {
            dataToUpdate.syncPrices = syncPrices;
        }
        if (mainPropertyId) {
            // Vérifier que la propriété est bien dans le groupe
            if (doc.data().properties && doc.data().properties.includes(mainPropertyId)) {
                dataToUpdate.mainPropertyId = mainPropertyId;
            } else {
                return res.status(400).send({ error: 'La propriété principale doit faire partie du groupe.' });
            }
        }

        if (Object.keys(dataToUpdate).length === 0) {
            return res.status(400).send({ error: 'Aucune donnée valide à mettre à jour (name, syncPrices ou mainPropertyId requis).' });
        }

        await groupRef.update(dataToUpdate);

        res.status(200).send({ message: 'Groupe mis à jour avec succès', id });
    } catch (error) {
        console.error('Erreur lors de la mise à jour du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour du groupe.' });
    }
});

app.delete('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const groupRef = db.collection('groups').doc(id);
        const doc = await groupRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (doc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        await groupRef.delete();
        res.status(200).send({ message: 'Groupe supprimé avec succès', id });
    } catch (error) {
        console.error('Erreur lors de la suppression du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la suppression du groupe.' });
    }
});

app.put('/api/groups/:id/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { propertyIds } = req.body;
        const userId = req.user.uid;
        if (!propertyIds || !Array.isArray(propertyIds)) {
            return res.status(400).send({ error: 'Un tableau d\'IDs de propriétés est requis.' });
        }
        const groupRef = db.collection('groups').doc(id);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (groupDoc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const teamId = userProfileDoc.exists ? userProfileDoc.data().teamId : userId;

        for (const propId of propertyIds) {
            const propRef = db.collection('properties').doc(propId);
            const propDoc = await propRef.get();
            const propTeamId = propDoc.exists ? (propDoc.data().teamId || propDoc.data().ownerId) : null;
            if (!propDoc.exists || propTeamId !== teamId) {
                return res.status(403).send({ error: `La propriété ${propId} est invalide ou n'appartient pas à votre équipe.` });
            }
        }
        await groupRef.update({
            properties: admin.firestore.FieldValue.arrayUnion(...propertyIds)
        });
        res.status(200).send({ message: 'Propriétés ajoutées au groupe avec succès.' });
    } catch (error) {
        console.error('Erreur lors de l\'ajout de propriétés au groupe:', error);
        res.status(500).send({ error: 'Erreur lors de l\'ajout de propriétés au groupe.' });
    }
});

app.delete('/api/groups/:id/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { propertyIds } = req.body;
        const userId = req.user.uid;
        if (!propertyIds || !Array.isArray(propertyIds) || propertyIds.length === 0) {
            return res.status(400).send({ error: 'Un tableau d\'IDs de propriétés est requis.' });
        }
        const groupRef = db.collection('groups').doc(id);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (groupDoc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        const currentPropertiesInGroup = groupDoc.data().properties || [];
        const propertiesToRemove = propertyIds.filter(propId => currentPropertiesInGroup.includes(propId));

        // Si on retire la propriété principale, on réinitialise mainPropertyId
        const mainPropertyId = groupDoc.data().mainPropertyId;
        let needsMainPropReset = false;
        if (mainPropertyId && propertiesToRemove.includes(mainPropertyId)) {
            needsMainPropReset = true;
        }

        if (propertiesToRemove.length === 0) {
            return res.status(404).send({ error: 'Aucune des propriétés spécifiées n\'a été trouvée dans ce groupe.' });
        }

        const updateData = {
            properties: admin.firestore.FieldValue.arrayRemove(...propertiesToRemove)
        };
        if (needsMainPropReset) {
            updateData.mainPropertyId = null; // Réinitialiser la propriété principale
        }

        await groupRef.update(updateData);
        res.status(200).send({ message: 'Propriétés retirées du groupe avec succès.' });
    } catch (error) {
        console.error('Erreur lors du retrait de propriétés du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles.' });
    }
});


// --- ROUTES DE GESTION D'ÉQUIPE (SÉCURISÉES) ---
app.post('/api/teams/invites', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { email: inviteeEmail, role = 'member' } = req.body;
        const inviterId = req.user.uid;

        if (!inviteeEmail) {
            return res.status(400).send({ error: 'L\'adresse e-mail de l\'invité est requise.' });
        }

        const allowedRoles = ['admin', 'manager', 'member'];
        if (!allowedRoles.includes(role)) {
            return res.status(400).send({ error: 'Rôle invalide.' });
        }

        const inviterProfileRef = db.collection('users').doc(inviterId);
        const inviterProfileDoc = await inviterProfileRef.get();
        if (!inviterProfileDoc.exists || !inviterProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Profil de l\'inviteur ou ID d\'équipe non trouvé.' });
        }
        const inviterData = inviterProfileDoc.data();
        const teamId = inviterData.teamId;

        if (inviterData.role !== 'admin') {
            return res.status(403).send({ error: 'Seul un administrateur peut inviter des membres.' });
        }

        let inviteeUser;
        try {
            inviteeUser = await admin.auth().getUserByEmail(inviteeEmail);
            const inviteeProfileRef = db.collection('users').doc(inviteeUser.uid);
            const inviteeProfileDoc = await inviteeProfileRef.get();
            if (inviteeProfileDoc.exists && inviteeProfileDoc.data().teamId) {
                return res.status(409).send({ error: 'Cet utilisateur fait déjà partie d\'une équipe.' });
            }
        } catch (error) {
            if (error.code !== 'auth/user-not-found') { throw error; }
        }

        const existingInviteQuery = await db.collection('invitations')
            .where('teamId', '==', teamId)
            .where('inviteeEmail', '==', inviteeEmail)
            .where('status', '==', 'pending')
            .limit(1)
            .get();

        if (!existingInviteQuery.empty) {
            return res.status(409).send({ error: 'Une invitation est déjà en attente pour cet utilisateur et cette équipe.' });
        }

        const invitation = {
            teamId: teamId,
            inviteeEmail: inviteeEmail,
            inviterId: inviterId,
            role: role,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await db.collection('invitations').add(invitation);

        console.log(`SIMULATION: Envoi d'un email d'invitation à ${inviteeEmail} pour rejoindre l'équipe ${teamId} avec le rôle ${role}. Invitation ID: ${docRef.id}`);

        res.status(201).send({
            message: 'Invitation envoyée avec succès (simulation)',
            inviteId: docRef.id
        });

    } catch (error) {
        console.error('Erreur lors de l\'invitation:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de l\'invitation.' });
    }
});

app.get('/api/teams/members', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        const membersSnapshot = await db.collection('users').where('teamId', '==', teamId).get();

        const members = membersSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name,
                email: data.email,
                role: data.role
            };
        });

        res.status(200).json(members);

    } catch (error) {
        console.error('Erreur lors de la récupération des membres de l\'équipe:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des membres de l\'équipe.' });
    }
});

app.put('/api/teams/members/:memberId/role', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { memberId } = req.params;
        const { role: newRole } = req.body;
        const adminId = req.user.uid;

        const allowedRoles = ['admin', 'manager', 'member'];
        if (!newRole || !allowedRoles.includes(newRole)) {
            return res.status(400).send({ error: 'Rôle invalide.' });
        }

        const adminProfileRef = db.collection('users').doc(adminId);
        const adminProfileDoc = await adminProfileRef.get();
        if (!adminProfileDoc.exists || adminProfileDoc.data().role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée. Seul un administrateur peut modifier les rôles.' });
        }
        const teamId = adminProfileDoc.data().teamId;

        if (adminId === memberId) {
            return res.status(400).send({ error: 'Vous ne pouvez pas modifier votre propre rôle.' });
        }

        const memberProfileRef = db.collection('users').doc(memberId);
        const memberProfileDoc = await memberProfileRef.get();
        if (!memberProfileDoc.exists) {
            return res.status(404).send({ error: 'Membre non trouvé.' });
        }
        if (memberProfileDoc.data().teamId !== teamId) {
            return res.status(403).send({ error: 'Ce membre ne fait pas partie de votre équipe.' });
        }

        await memberProfileRef.update({ role: newRole });

        res.status(200).send({ message: 'Rôle du membre mis à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la modification du rôle:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la modification du rôle.' });
    }
});

app.delete('/api/teams/members/:memberId', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { memberId } = req.params;
        const adminId = req.user.uid;

        const adminProfileRef = db.collection('users').doc(adminId);
        const adminProfileDoc = await adminProfileRef.get();
        if (!adminProfileDoc.exists || adminProfileDoc.data().role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée. Seul un administrateur peut supprimer des membres.' });
        }
        const teamId = adminProfileDoc.data().teamId;

        if (adminId === memberId) {
            return res.status(400).send({ error: 'Vous ne pouvez pas vous supprimer vous-même de l\'équipe.' });
        }

        const memberProfileRef = db.collection('users').doc(memberId);
        const memberProfileDoc = await memberProfileRef.get();
        if (!memberProfileDoc.exists) {
            return res.status(404).send({ error: 'Membre non trouvé.' });
        }
        if (memberProfileDoc.data().teamId !== teamId) {
            return res.status(403).send({ error: 'Ce membre ne fait pas partie de votre équipe.' });
        }

        await memberProfileRef.update({
            teamId: admin.firestore.FieldValue.delete(),
            role: admin.firestore.FieldValue.delete()
        });

        res.status(200).send({ message: 'Membre retiré de l\'équipe avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la suppression du membre:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la suppression du membre.' });
    }
});


// --- ROUTES POUR LES RAPPORTS (SÉCURISÉES) ---
app.get('/api/reports/kpis', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { startDate, endDate } = req.query; // ex: '2025-01-01', '2025-01-31'

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId de l'utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        // 2. Récupérer le nombre total de propriétés dans l'équipe pour le calcul de l'occupation
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const totalPropertiesInTeam = propertiesSnapshot.size;

        if (totalPropertiesInTeam === 0) {
            return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: 0 });
        }

        // 3. Calculer le nombre de jours dans la période
        const start = new Date(startDate);
        const end = new Date(endDate);
        const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1; // +1 pour inclure le dernier jour
        const totalNightsAvailable = totalPropertiesInTeam * daysInPeriod;

        // 4. Interroger toutes les réservations de l'équipe qui chevauchent la période
        const bookingsQuery = db.collectionGroup('reservations')
            .where('teamId', '==', teamId)
            .where('startDate', '<=', endDate) // Commencé avant ou pendant la fin
            .where('endDate', '>', startDate);  // Fini après ou pendant le début

        const snapshot = await bookingsQuery.get();

        if (snapshot.empty) {
            return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: totalNightsAvailable });
        }

        let totalRevenue = 0;
        let totalNightsBooked = 0;

        // 5. Calculer les KPIs
        snapshot.forEach(doc => {
            const booking = doc.data();
            const bookingStart = new Date(booking.startDate);
            const bookingEnd = new Date(booking.endDate);

            const effectiveStart = new Date(Math.max(bookingStart.getTime(), start.getTime()));
            const effectiveEnd = new Date(Math.min(bookingEnd.getTime(), end.getTime()));

            let nightsInPeriod = 0;
            let currentDate = new Date(effectiveStart);
            while (currentDate < effectiveEnd && currentDate <= end) { // s'arrête à la fin de la période
                nightsInPeriod++;
                currentDate.setDate(currentDate.getDate() + 1);
            }

            totalNightsBooked += nightsInPeriod;
            totalRevenue += (booking.pricePerNight || 0) * nightsInPeriod;
        });

        const adr = totalNightsBooked > 0 ? totalRevenue / totalNightsBooked : 0;
        const occupancy = totalNightsAvailable > 0 ? (totalNightsBooked / totalNightsAvailable) * 100 : 0;

        res.status(200).json({
            totalRevenue,
            totalNightsBooked,
            adr,
            occupancy: occupancy, // Déjà en pourcentage
            totalNightsAvailable
        });

    } catch (error) {
        if (error.message && error.message.includes('requires an index')) {
            console.error('ERREUR FIRESTORE - Index manquant :', error.message);
            return res.status(500).send({ error: 'Index Firestore manquant. Veuillez exécuter la requête pour obtenir le lien de création dans les logs du serveur.' });
        }
        console.error('Erreur lors du calcul des KPIs:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des KPIs.' });
    }
});


// --- ROUTES DE L'IA DE TARIFICATION (SÉCURISÉES) ---

// Fonction utilitaire pour attendre (utilisée pour le retry)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fonction helper pour appeler l'API Gemini avec retry
 */
async function callGeminiAPI(prompt, maxRetries = 3) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY non trouvée dans .env");
        throw new Error("Clé API Gemini non configurée sur le serveur.");
    }
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.status === 429) {
                console.warn(`Tentative ${attempt}/${maxRetries}: API Gemini surchargée (429). Nouvel essai dans ${attempt} seconde(s)...`);
                await delay(attempt * 1000);
                continue;
            }

            if (!response.ok) {
                const errorBody = await response.json();
                console.error(`Erreur API Gemini (Tentative ${attempt}):`, errorBody);
                throw new Error(`Erreur de l'API Gemini: ${errorBody.error?.message || response.statusText}`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];
            const textPart = candidate?.content?.parts?.[0]?.text;

            if (textPart) {
                try {
                    return JSON.parse(textPart);
                } catch (parseError) {
                    console.error("Erreur de parsing JSON de la réponse Gemini:", textPart);
                    throw new Error("Réponse de l'API Gemini reçue mais n'est pas un JSON valide.");
                }
            } else {
                console.error("Réponse Gemini inattendue:", result);
                throw new Error("Réponse de l'API Gemini malformée ou vide.");
            }
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            console.error(`Erreur lors de la tentative ${attempt} d'appel à Gemini:`, error.message);
            if (!error.message.includes('429')) {
                await delay(attempt * 1000);
            }
        }
    }
    throw new Error(`Échec de l'appel à l'API Gemini après ${maxRetries} tentatives.`);
}

/**
 * Fonction helper pour appeler l'API Gemini avec l'outil de recherche
 */
async function callGeminiWithSearch(prompt, maxRetries = 3) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("Clé API Gemini non configurée sur le serveur.");
    }
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ "google_search": {} }],
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.status === 429) {
                console.warn(`Tentative ${attempt}/${maxRetries}: API Gemini (Search) surchargée. Nouvel essai...`);
                await delay(attempt * 1000);
                continue;
            }
            if (!response.ok) {
                const errorBody = await response.json();
                console.error(`Erreur API Gemini (Search) (Tentative ${attempt}):`, errorBody);
                throw new Error(`Erreur de l'API Gemini (Search): ${errorBody.error?.message || response.statusText}`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];
            const textPart = candidate?.content?.parts?.[0]?.text;

            if (textPart) {
                try {
                    const cleanText = textPart.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                    return JSON.parse(cleanText);
                } catch (parseError) {
                    console.error("Erreur de parsing JSON de la réponse Gemini (Search):", textPart);
                    throw new Error("Réponse de l'API Gemini (Search) reçue mais n'est pas un JSON valide.");
                }
            } else {
                console.error("Réponse Gemini (Search) inattendue:", result);
                if (candidate?.finishReason === 'SAFETY') {
                    throw new Error("La réponse de l'IA a été bloquée pour des raisons de sécurité.");
                } else if (candidate?.finishReason === 'OTHER') {
                    throw new Error("L'API Gemini n'a pas pu terminer la recherche.");
                }
                throw new Error("Réponse de l'API Gemini (Search) malformée ou vide.");
            }
        } catch (error) {
            if (attempt === maxRetries) {
                throw new Error(`Échec de l'appel à l'API Gemini (Search) après ${maxRetries} tentatives. ${error.message}`);
            }
            console.error(`Erreur (Search) Tentative ${attempt}:`, error.message);
            if (!error.message.includes('429')) {
                await delay(attempt * 1000);
            }
        }
    }
}

// POST /api/properties/:id/pricing-strategy - Générer une stratégie de prix
app.post('/api/properties/:id/pricing-strategy', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;

        const propertyRef = db.collection('properties').doc(id);
        const propertyDoc = await propertyRef.get();

        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }

        const property = propertyDoc.data();
        const today = new Date().toISOString().split('T')[0];

        const prompt = `
            Tu es un expert mondial en tarification dynamique pour le marché de la location saisonnière (${property.location}).
            Ton objectif est de créer une stratégie de prix détaillée, jour par jour, pour les 180 prochains jours, en respectant les règles définies par l'utilisateur.

            PROPRIÉTÉ À ANALYSER:
            ${JSON.stringify({
            address: property.address,
            location: property.location,
            property_type: property.property_type,
            capacity: property.capacity,
            surface: property.surface,
            amenities: property.amenities || []
        })}

            RÈGLES UTILISATEUR À RESPECTER IMPÉRATIVEMENT:
            - Stratégie Générale: ${property.strategy || 'Équilibré'} (Adapte l'agressivité des prix selon: Prudent=focus occupation, Équilibré=compromis, Agressif=focus ADR)
            - Prix Plancher Absolu: ${property.floor_price} € (Ne JAMAIS proposer un prix inférieur)
            - Prix de Référence (Base): ${property.base_price} € (Utilise comme point de départ pour tes ajustements)
            - Prix Plafond (Optionnel): ${property.ceiling_price != null ? property.ceiling_price + ' €' : 'Aucun'} (Ne JAMAIS proposer un prix supérieur si défini)
            - Durée Minimale de Séjour: ${property.min_stay != null ? property.min_stay + ' nuits' : 'Aucune'}
            - Durée Maximale de Séjour: ${property.max_stay != null ? property.max_stay + ' nuits' : 'Aucune'}
            - Réduction Hebdomadaire: ${property.weekly_discount_percent != null ? property.weekly_discount_percent + '%' : 'Aucune'}
            - Réduction Mensuelle: ${property.monthly_discount_percent != null ? property.monthly_discount_percent + '%' : 'Aucune'}
            - Majoration Week-end (Ven/Sam): ${property.weekend_markup_percent != null ? property.weekend_markup_percent + '%' : 'Aucune'}

            INSTRUCTIONS DÉTAILLÉES:
            1.  **Analyse des Facteurs de Demande (180 jours à partir du ${today}) pour "${property.location}"**:
                * **Saisonnalité:** Haute, moyenne, basse saison.
                * **Effet Week-end:** Majoration si définie.
                * **Jours Fériés & Vacances Scolaires (France Zone A, B, C):** Impact sur la demande.
                * **Événements Locaux:** Recherche simulée (festivals, conférences, etc.).
                * **Qualité du bien:** Prendre en compte les équipements fournis.

            2.  **Génération des Prix Journaliers (180 jours):**
                * Pour CHAQUE jour, calcule un prix optimal.
                * Commence par le prix de base, puis ajuste en fonction des facteurs de demande ET des règles utilisateur.
                * **Contraintes:** Le prix final doit TOUJOURS être >= Prix Plancher et <= Prix Plafond (si défini).
                * **Stratégie:** Si 'Prudent', baisse légèrement pour remplir. Si 'Agressif', augmente fortement sur forte demande. Si 'Équilibré', cherche le meilleur compromis.
                * **Justification:** Fournis une raison CLAIRE pour chaque prix (ex: "Base + Majoration WE", "Haute saison + Vacances", "Événement + Agressif").

            FORMAT DE SORTIE OBLIGATOIRE (JSON uniquement, sans texte avant/après):
            {
              "strategy_summary": "Résumé très bref de la stratégie globale.",
              "daily_prices": [ { "date": "YYYY-MM-DD", "price": 135, "reason": "Basse saison" }, /* ... autres jours ... */ ]
            }
        `;

        const strategyResult = await callGeminiAPI(prompt);

        if (!strategyResult || !Array.isArray(strategyResult.daily_prices) || strategyResult.daily_prices.length === 0) {
            throw new Error("La réponse de l'IA est invalide ou ne contient pas de prix journaliers.");
        }
        const batch = db.batch();
        const floor = property.floor_price;
        const ceiling = property.ceiling_price;

        for (const day of strategyResult.daily_prices) {
            const priceNum = Number(day.price);
            if (isNaN(priceNum)) {
                console.warn(`Prix invalide reçu pour ${day.date}: ${day.price}. Utilisation du prix plancher.`);
                day.price = floor;
                continue;
            }

            let finalPrice = priceNum;
            if (priceNum < floor) {
                console.warn(`Prix ${priceNum}€ pour ${day.date} inférieur au plancher ${floor}€. Ajustement.`);
                finalPrice = floor;
            }
            if (ceiling != null && priceNum > ceiling) {
                console.warn(`Prix ${priceNum}€ pour ${day.date} supérieur au plafond ${ceiling}€. Ajustement.`);
                finalPrice = ceiling;
            }

            const dayRef = db.collection('properties').doc(id).collection('price_overrides').doc(day.date);
            batch.set(dayRef, {
                date: day.date,
                price: finalPrice,
                reason: day.reason || "Stratégie IA"
            });
        }

        await batch.commit();
        console.log(`Stratégie IA sauvegardée pour ${id} avec ${strategyResult.daily_prices.length} jours.`);

        res.status(200).json(strategyResult);

    } catch (error) {
        console.error('Erreur lors de la génération de la stratégie de prix:', error);
        if (error.message.includes('429') || error.message.includes('overloaded')) {
            res.status(503).send({ error: `L'API de génération de prix est temporairement surchargée. Veuillez réessayer plus tard.` });
        } else {
            res.status(500).send({ error: `Erreur du serveur lors de la génération de la stratégie: ${error.message}` });
        }
    }
});

// GET /api/news - Récupérer les actualités du marché (depuis le cache)
app.get('/api/news', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const newsRef = db.collection('system').doc('marketNews');
        const newsDoc = await newsRef.get();

        if (!newsDoc.exists) {
            return res.status(404).send({ error: 'Cache d\'actualités non encore généré. Veuillez patienter.' });
        }

        res.status(200).json(newsDoc.data().data);

    } catch (error) {
        console.error('Erreur lors de la récupération des actualités depuis le cache:', error);
        res.status(500).send({ error: `Erreur serveur lors de la récupération des actualités: ${error.message}` });
    }
});


// --- TÂCHES PLANIFIÉES (CRON JOBS) ---
/**
 * Met à jour le cache des actualités du marché dans Firestore.
 */
async function updateMarketNewsCache() {
    console.log('Tâche planifiée : Démarrage de la mise à jour des actualités...');
    try {
        const prompt = `
            Tu es un analyste de marché expert pour la location saisonnière en France.
            Utilise l'outil de recherche pour trouver les 3-4 actualités ou tendances 
            les plus récentes et pertinentes (moins de 7 jours) qui impactent 
            le marché de la location (type Airbnb, Booking) en France.
            Recherche aussi des événements majeurs (concerts, festivals, salons) 
            annoncés récemment en France pour les 6 prochains mois.

            Pour chaque actualité:
            1. Fournis un titre concis.
            2. Fais un résumé d'une phrase.
            3. Estime l'impact sur les prix en pourcentage (ex: 15 pour +15%, -5 pour -5%).
            4. Catégorise cet impact comme "élevé", "modéré", ou "faible".

            Réponds UNIQUEMENT avec un tableau JSON valide. 
            N'inclus aucun texte avant ou après le tableau, même pas \`\`\`json.
            Le format doit être:
            [
                {
                    "title": "Titre de l'actualité",
                    "summary": "Résumé de l'actualité.",
                    "source": "Nom de la source (ex: 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "élevé"
                }
            ]
        `;

        const newsData = await callGeminiWithSearch(prompt); // Appelle la fonction avec retry

        if (!newsData || !Array.isArray(newsData)) {
            throw new Error("Données d'actualités invalides reçues de Gemini.");
        }

        const db = admin.firestore();
        const newsRef = db.collection('system').doc('marketNews');
        await newsRef.set({
            data: newsData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('Mise à jour du cache des actualités terminée avec succès.');

    } catch (error) {
        console.error('Erreur lors de la mise à jour du cache des actualités:', error.message);
    }
}

// Planifier la tâche pour s'exécuter tous les jours à 3h00 du matin
console.log("Mise en place de la tâche planifiée pour les actualités (tous les jours à 3h00).");
cron.schedule('0 3 * * *', () => {
    updateMarketNewsCache();
}, {
    scheduled: true,
    timezone: "Europe/Paris"
});

// Lancer une mise à jour au démarrage du serveur (pour avoir des données fraîches)
setTimeout(updateMarketNewsCache, 10000); // Délai de 10s


// --- DÉMARRAGE DU SERVEUR ---
app.listen(port, () => {
    console.log(`Le serveur écoute sur le port ${port}`);
});

