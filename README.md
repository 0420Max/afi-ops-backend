# AFI OPS Backend

Backend sécurisé pour AFI OPS Cockpit.

## Installation

```
npm install
```

## Variables d'environnement

Crée un fichier `.env` avec tes clés :

```
TWILIO_ACCOUNT_SID=...
TWILIO_API_KEY=...
TWILIO_API_SECRET=...
TWILIO_TWIML_APP_SID=...
MONDAY_TOKEN=...
OUTLOOK_CLIENT_ID=...
TIDIO_PROJECT_ID=...
```

## Démarrage local

```
npm start
```

Le serveur démarre sur `http://localhost:3000`

## Endpoints

- `GET /` - Health check
- `POST /api/twilio-token` - Génère token Twilio
- `POST /api/monday-tickets` - Récupère tickets Monday
- `POST /api/outlook-auth` - OAuth Outlook
- `GET /api/tidio-config` - Config Tidio
