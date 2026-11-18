# COOL MESSENGER

Messagerie web installable (Windows, Android, iOS, navigateur) avec un serveur Python / FastAPI.

## Fonctions
- Comptes avec mot de passe haché (bcrypt) et session par jeton signé.
- Messages texte entre comptes, historique, actualisation automatique, compteur de non-lus.
- Messages vocaux (micro du navigateur) : un clic pour démarrer, un clic pour envoyer ou annuler.
- SMS classiques via Twilio (facultatif), avec quota quotidien par utilisateur.
- Page d'installation à partager : `/installer`. Elle détecte l'appareil : téléchargement de l'APK
  sur Android, guide « Sur l'écran d'accueil » sur iPhone (iOS 12 et plus, iPhone 5s et plus récents).
  Pour mettre à jour l'APK, remplacer `app/static/cool-messenger.apk`.
- Application installable sur Android et iPhone (PWA) : bouton « Installer » dans l'application,
  guide pas à pas sur iPhone, plein écran, clavier et encoche gérés. Pour publier sur le Play Store,
  générer le paquet Android sur https://www.pwabuilder.com à partir de l'adresse du site, puis renseigner
  `ANDROID_ASSETLINKS` avec le fichier assetlinks.json fourni.
- Six thèmes au choix (icône palette) : Classique, Nuit, Douceur, Crépuscule, Forêt, Corail. Le choix est
  mémorisé sur l'appareil. Pour en ajouter un : un bloc `[data-theme="nom"]` dans `app/static/app.css`,
  puis son nom dans les listes de `theme.js` et `app.js`.
- Filtre « Tous / Non lus » sur la liste des conversations.

## Démarrer sur Windows

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Ouvrir ensuite http://127.0.0.1:8000. Aucun réglage n'est obligatoire : la clé de session est créée
automatiquement dans `data/.secret_key`. Pour personnaliser, copier `.env.example` en `.env`.

Sur macOS / Linux : `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn app.main:app`.

## Mettre en ligne

Le micro et l'installation sur téléphone exigent une adresse **HTTPS**. Le serveur doit tourner en
**un seul processus** (base SQLite et limiteur de débit locaux) derrière un proxy qui fournit le HTTPS.

**Docker (VPS, Render, Fly.io, Railway…)**

```bash
docker build -t cool-messenger .
docker run -d -p 8000:8000 -v cool-data:/data -e SECRET_KEY="une-longue-cle-aleatoire-de-48-caracteres" cool-messenger
```

**Render** : pousser le dossier sur GitHub puis *New > Blueprint* ; `render.yaml` crée le service, le
disque persistant et la clé secrète. Le disque persistant nécessite une offre payante.

À sauvegarder régulièrement : le dossier de données (`data/` ou le volume `/data`), qui contient la base,
les messages vocaux et la clé de session.

## SMS (facultatif)
Renseigner `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` et `TWILIO_FROM_NUMBER` dans `.env`, puis redémarrer.
Un bouton SMS apparaît alors dans l'application. Chaque SMS est facturé par Twilio : `SMS_DAILY_LIMIT`
(10 par défaut) plafonne les envois par utilisateur et par jour. Vérifier la couverture et les tarifs pour
la Côte d'Ivoire avant d'activer.

## Sécurité
- Clé de session forte obligatoire : une clé absente, courte ou par défaut est remplacée par une clé aléatoire.
- Limitation des tentatives de connexion, des inscriptions, des envois de messages, de vocaux et de SMS.
- Les numéros de téléphone ne sont jamais communiqués aux autres utilisateurs.
- Vocaux : format vérifié sur le contenu réel, taille limitée à 12 Mo, lecture réservée à l'expéditeur et au destinataire.
- En-têtes de sécurité (CSP stricte sans script en ligne, anti-iframe, nosniff, HSTS en HTTPS).
- `/docs` désactivé par défaut.

## Limites connues
- Pas de chiffrement de bout en bout : l'administrateur du serveur peut lire la base.
- Pas de notifications push, d'appels, ni de réinitialisation de mot de passe oublié.
- Une session reste valable 7 jours ; changer `SECRET_KEY` déconnecte tout le monde.
- Tout utilisateur inscrit peut trouver les autres par leur nom : pour un usage privé, restreindre l'accès au site.
