if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const { google } = require("googleapis");
const axios = require("axios");
const Airtable = require("airtable");
const cities = require("./cities");

// --------------------
// Airtable setup
// --------------------
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

// --------------------
// Tunables
// --------------------
const NEW_RESULTS_LIMIT = 20;

// --------------------
// Google Sheets setup
// --------------------
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: "sheets-search-log-bc033bbc638b.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const sheets = google.sheets({ version: "v4", auth });

let existingPlaceIds = new Set();

async function loadExistingBusinesses() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "'Search Log'!D:D",
    });

    const placeIds = res.data.values ? res.data.values.flat() : [];
    existingPlaceIds = new Set(placeIds.filter(Boolean));

    console.log(`ℹ️ Loaded ${existingPlaceIds.size} existing Place IDs`);
  } catch (err) {
    console.error("❌ Error reading Google Sheets:", err.message);
  }
}

function isLoggedInSearchLogCached(placeId) {
  return existingPlaceIds.has(placeId);
}

async function logBusinessSearch(businessName, address, placeId) {
  try {
    if (isLoggedInSearchLogCached(placeId)) return;

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "'Search Log'!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[businessName, address, new Date().toISOString().split("T")[0], placeId]],
      },
    });

    existingPlaceIds.add(placeId);
  } catch (err) {
    console.error(`❌ Error logging business: ${err.message}`);
  }
}

// --------------------
// Airtable helpers
// --------------------
async function isDuplicate(businessName) {
  try {
    const records = await base(process.env.AIRTABLE_TABLE_NAME)
      .select({
        filterByFormula: `{Business Name} = "${businessName}"`,
        maxRecords: 1,
      })
      .firstPage();

    return records.length > 0;
  } catch {
    return false;
  }
}

async function addToAirtable(data) {
  try {
    if (await isDuplicate(data.businessName)) return;

    await base(process.env.AIRTABLE_TABLE_NAME).create([
      {
        fields: {
          "Lead Name": data.leadName || "",
          "Contact Profile URL": data.contactProfileURL || "",
          Platform: "Google Maps",
          "Business Name": data.businessName,
          "Business URL": data.businessURL,
          "City/State": data.cityState,
          "Business Number": data.phone || "",
          "Quality of Website": data.websiteQuality,
        },
      },
    ]);

    console.log(`✅ Added to Airtable: ${data.businessName}`);
  } catch (err) {
    console.error(`❌ Error adding to Airtable: ${err.message}`);
  }
}

// --------------------
// Google Places helpers
// --------------------
async function getPlaceDetails(placeId) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,website,formatted_phone_number,user_ratings_total,rating,business_status&key=${process.env.GOOGLE_API_KEY}`;
    const res = await axios.get(url);
    return res.data.result || {};
  } catch {
    return {};
  }
}

async function searchPlaces(query, location, maxResults = 20) {
  let allResults = [];
  let nextPageToken = null;

  do {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&location=${location}&radius=5000&key=${process.env.GOOGLE_API_KEY}${
      nextPageToken ? `&pagetoken=${nextPageToken}` : ""
    }`;

    const res = await axios.get(url);
    allResults = allResults.concat(res.data.results || []);
    nextPageToken = res.data.next_page_token;

    if (nextPageToken) await new Promise(r => setTimeout(r, 2000));
  } while (nextPageToken && allResults.length < maxResults);

  return allResults.slice(0, maxResults);
}

// --------------------
// Website quality evaluation
// --------------------
function evaluateWebsiteQuality(url) {
  if (!url) return "No Website";

  if (
    url.includes("linktr.ee") ||
    url.includes("joinblvd.com") ||
    url.includes("square.site") ||
    url.includes("facebook.com")
  ) {
    return "Poor";
  }

  return "Decent";
}

// --------------------
// City grid sweep
// --------------------
const searchGridOffset = 0.03;

function generateCityGrid(coord) {
  const [lat, lng] = coord.split(",").map(Number);
  return [
    `${lat},${lng}`,
    `${lat + searchGridOffset},${lng}`,
    `${lat - searchGridOffset},${lng}`,
    `${lat},${lng + searchGridOffset}`,
    `${lat},${lng - searchGridOffset}`,
  ];
}

// --------------------
// Main execution
// --------------------
(async () => {
  await loadExistingBusinesses();

  const keywords = [
    "medical spa",
    "med spa",
    "medical aesthetics",
    "aesthetic clinic",
    "cosmetic dermatology",
    "laser clinic",
    "injectables clinic",
    "skin clinic",
  //     "botox",
  // "fillers",
  // "laser hair removal",
  // "microneedling",
  // "hydrafacial",
  // "morpheus8",
  // "ipl laser",
  // "rf microneedling",
  // "body contouring",
  // "skin tightening",
  ];

  for (const city of cities) {
    const points = generateCityGrid(city.coords);

    for (const point of points) {
      for (const keyword of keywords) {
        console.log(`\n🏙️ ${city.name} | ${keyword}`);

        const results = await searchPlaces(keyword, point, 60);
        let newCount = 0;

        for (const place of results) {
          if (newCount >= NEW_RESULTS_LIMIT) break;

          const details = await getPlaceDetails(place.place_id);

          const businessName = details.name || place.name;
          const address = details.formatted_address || "";
          const placeId = place.place_id;

          if (!businessName || !address || !placeId) continue;
          if (isLoggedInSearchLogCached(placeId)) continue;

          // ✅ NEW QUALIFICATION FILTERS
          if (details.business_status !== "OPERATIONAL") continue;

          const hasContact =
            details.website || details.formatted_phone_number;
          if (!hasContact) continue;

          if ((details.user_ratings_total || 0) < 5) continue;

          const websiteQuality = evaluateWebsiteQuality(details.website);

          await addToAirtable({
            leadName: "",
            contactProfileURL: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
            businessName,
            businessURL: details.website || "",
            cityState: address,
            phone: details.formatted_phone_number || "",
            websiteQuality,
          });

          await logBusinessSearch(businessName, address, placeId);
          newCount++;
        }
      }
    }
  }
})();
