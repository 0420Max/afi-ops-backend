// logToSheet.js
const { google } = require('googleapis');

// Parse les credentials à partir de la variable d'environnement
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// Authentification Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// ID du Google Sheet (le tien est déjà bon)
const SHEET_ID = '1B-Fm3Ngyyo0OjgnPVOfCjdZjwuKcvlzSq9kTcd44s7c';
const SHEET_NAME = 'Log'; // L’onglet doit exister et s’appeler "Log"

async function logSubmission({ fullName, intent, status, mondayId, error }) {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const values = [[
      new Date().toISOString(),
      fullName || '',
      intent || '',
      status || '',
      mondayId || '',
      error || ''
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:F`,
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
  } catch (err) {
    console.error('Erreur logToSheet.js:', err.message);
  }
}

module.exports = { logSubmission };
