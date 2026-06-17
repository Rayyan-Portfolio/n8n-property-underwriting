// Google Form → n8n webhook (paste in Form → Extensions → Apps Script)
const WEBHOOK_URL = 'https://YOUR-NGROK-URL/webhook/YOUR-WEBHOOK-PATH';
const SECRET = ''; // set when Header Auth enabled

function getField(responses, title) {
  const want = title.trim().toLowerCase();
  const hit = responses.find(i =>
    i.getItem().getTitle().trim().toLowerCase() === want
  );
  if (!hit) return '';
  const v = hit.getResponse();
  return Array.isArray(v) ? v[0] : v;
}

function getState(responses) {
  const titles = ['State code in 2 letters (TX, not Texas).', 'State'];
  for (const t of titles) {
    const v = getField(responses, t);
    if (v) return v;
  }
  const hit = responses.find(i => /state/i.test(i.getItem().getTitle()));
  if (!hit) return '';
  const v = hit.getResponse();
  return Array.isArray(v) ? v[0] : v;
}

function onFormSubmit(e) {
  const r = e.response.getItemResponses();
  const payload = {
    address: getField(r, 'Address'),
    city: getField(r, 'City'),
    state: getState(r),
    zip: getField(r, 'Zip'),
    beds: getField(r, 'Beds'),
    baths: getField(r, 'Baths'),
    sqft: getField(r, 'Sqft'),
    yearBuilt: getField(r, 'Year Built'),
    askingPrice: getField(r, 'Asking price'),
    condition: getField(r, 'Condition'),
    notes: getField(r, 'Notes')
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  if (SECRET) options.headers = { 'x-webhook-secret': SECRET };
  const res = UrlFetchApp.fetch(WEBHOOK_URL, options);
  Logger.log('Payload: ' + JSON.stringify(payload));
  Logger.log(res.getResponseCode() + ': ' + res.getContentText());
}
