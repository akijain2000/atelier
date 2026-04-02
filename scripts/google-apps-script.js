/**
 * Google Apps Script — Atelier Lead Ingestion Webhook
 *
 * SETUP:
 * 1. Open Google Sheets → Extensions → Apps Script
 * 2. Paste this entire file into Code.gs
 * 3. Set Script Properties (Project Settings → Script Properties):
 *    - ATELIER_WEBHOOK_URL = https://atelier-production-b43e.up.railway.app/api/leads/ingest
 *    - ATELIER_WEBHOOK_SECRET = (same value as WEBHOOK_SECRET in Atelier .env)
 *    - ATELIER_LISTING_ID = N94_3ROMS (or whichever listing this form is for)
 * 4. Add trigger: onFormSubmit → From spreadsheet → On form submit
 *
 * COLUMN MAPPING (your "Lead skjema" form):
 *   A = Timestamp
 *   B = Hva er ditt fulle navn?              → name
 *   C = Hva er din alder?                    → age
 *   D = Hva er din e-post?                   → email
 *   E = Telefonnummer inkl landskode          → phone
 *   F = Når ønsker du å leie i fra?           → move_in_date
 *   G = Hva er din nåværende status?          → tenant_status
 *   H = En kort intro/beskrivelse             → intro
 *   I = Kjønn (valgfritt)                     → gender
 */

function onFormSubmit(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const webhookUrl = props.getProperty('ATELIER_WEBHOOK_URL');
    const webhookSecret = props.getProperty('ATELIER_WEBHOOK_SECRET');
    const listingId = props.getProperty('ATELIER_LISTING_ID') || 'N94_3ROMS';

    if (!webhookUrl || !webhookSecret) {
      Logger.log('ERROR: Missing ATELIER_WEBHOOK_URL or ATELIER_WEBHOOK_SECRET in Script Properties');
      return;
    }

    var values;
    var row;

    if (e && e.values) {
      values = e.values;
      row = e.range ? e.range.getRow() : 'unknown';
      Logger.log('Using e.values (length=' + values.length + '), row=' + row);
    } else if (e && e.range) {
      row = e.range.getRow();
      var sheet = e.range.getSheet();
      values = sheet.getRange(row, 1, 1, 10).getValues()[0];
      Logger.log('Using sheet.getRange, row=' + row);
    } else {
      Logger.log('ERROR: No event data. e=' + JSON.stringify(e));
      return;
    }

    Logger.log('Raw values: ' + JSON.stringify(values));

    var payload = {
      name: String(values[1] || '').trim(),
      age: values[2] ? String(values[2]).trim() : null,
      email: String(values[3] || '').trim(),
      phone: String(values[4] || '').trim(),
      move_in_date: values[5] ? String(values[5]).trim() : null,
      tenant_status: String(values[6] || '').trim(),
      intro: String(values[7] || '').trim(),
      gender: values[8] ? String(values[8]).trim() : null,
      listing_id: listingId,
      consent_sms: true,
      row_id: String(row),
      timestamp: values[0] ? new Date(values[0]).toISOString() : new Date().toISOString(),
    };

    if (!payload.phone) {
      Logger.log('SKIP: No phone number. payload=' + JSON.stringify(payload));
      return;
    }

    Logger.log('Sending payload for: ' + payload.name + ' / ' + payload.phone);

    var bodyStr = JSON.stringify(payload);
    var signature = computeHmacSha256(webhookSecret, bodyStr);

    var response = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: bodyStr,
      headers: {
        'X-Webhook-Signature': signature,
        'X-Webhook-Token': webhookSecret,
      },
      muteHttpExceptions: true,
    });

    var code = response.getResponseCode();
    var body = response.getContentText();

    if (code >= 200 && code < 300) {
      Logger.log('OK (row ' + row + '): ' + body);
    } else {
      Logger.log('ERROR (row ' + row + '): HTTP ' + code + ' — ' + body);
    }
  } catch (err) {
    Logger.log('EXCEPTION: ' + err.message + '\nStack: ' + err.stack);
  }
}

/**
 * Compute HMAC-SHA256 and return hex string.
 */
function computeHmacSha256(secret, message) {
  const signature = Utilities.computeHmacSha256Signature(message, secret);
  return signature.map(function (byte) {
    return ('0' + (byte & 0xff).toString(16)).slice(-2);
  }).join('');
}

/**
 * Manual backfill: process all existing rows that haven't been sent yet.
 * Run this once if you have existing form responses before the trigger was set up.
 */
function backfillExistingRows() {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty('ATELIER_WEBHOOK_URL');
  const webhookSecret = props.getProperty('ATELIER_WEBHOOK_SECRET');
  const listingId = props.getProperty('ATELIER_LISTING_ID') || 'N94_3ROMS';

  if (!webhookUrl || !webhookSecret) {
    Logger.log('ERROR: Missing Script Properties');
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    Logger.log('No data rows found');
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  let sent = 0;
  let skipped = 0;

  for (let i = 0; i < data.length; i++) {
    const values = data[i];
    const row = i + 2;
    const phone = String(values[4] || '').trim();

    if (!phone) {
      skipped++;
      continue;
    }

    const payload = {
      name: String(values[1] || '').trim(),
      age: values[2] ? String(values[2]).trim() : null,
      email: String(values[3] || '').trim(),
      phone: phone,
      move_in_date: values[5] ? String(values[5]).trim() : null,
      tenant_status: String(values[6] || '').trim(),
      intro: String(values[7] || '').trim(),
      gender: String(values[8] || '').trim() || null,
      listing_id: listingId,
      consent_sms: true,
      row_id: String(row),
      timestamp: values[0] ? new Date(values[0]).toISOString() : new Date().toISOString(),
    };

    const bodyStr = JSON.stringify(payload);
    const signature = computeHmacSha256(webhookSecret, bodyStr);

    try {
      const response = UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: bodyStr,
        headers: {
          'X-Webhook-Signature': signature,
          'X-Webhook-Token': webhookSecret,
        },
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        sent++;
        Logger.log('Sent row ' + row);
      } else {
        Logger.log('ERROR row ' + row + ': HTTP ' + code);
      }
    } catch (err) {
      Logger.log('FETCH ERROR row ' + row + ': ' + err.message);
    }

    Utilities.sleep(500);
  }

  Logger.log('Backfill complete. Sent: ' + sent + ', Skipped: ' + skipped);
}
