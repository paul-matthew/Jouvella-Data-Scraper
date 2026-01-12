if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const { google } = require("googleapis");
const axios = require("axios");
const Airtable = require("airtable");
const cities = require("./cities");

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const MIN_REVIEWS = 20;
const MIN_RATING = 3.0;
const NEW_RESULTS_LIMIT = 20; // bump to 60 when done testing

// Google Sheets setup
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

async function isDuplicate(businessName) {
  try {
    const records = await base(process.env.AIRTABLE_TABLE_NAME)
      .select({ filterByFormula: `{Business Name} = "${businessName}"`, maxRecords: 1 })
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
    console.log(`✅ Added to Airtable: ${data.businessName} (${data.websiteQuality})`);
  } catch (err) {
    console.error(`❌ Error adding to Airtable: ${err.message}`);
  }
}

async function getPlaceDetails(placeId) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,website,formatted_phone_number,user_ratings_total,rating,business_status&key=${process.env.GOOGLE_API_KEY}`;
    const res = await axios.get(url);
    return res.data.result || {};
  } catch {
    return {};
  }
}

// Rank by distance search
async function searchPlaces(query, location, maxResults = 20) {
  let allResults = [];
  let nextPageToken = null;
  do {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&location=${location}&rankby=distance&key=${process.env.GOOGLE_API_KEY}${
      nextPageToken ? `&pagetoken=${nextPageToken}` : ""
    }`;
    const res = await axios.get(url);
    allResults = allResults.concat(res.data.results || []);
    nextPageToken = res.data.next_page_token;
    if (nextPageToken) await new Promise(r => setTimeout(r, 2000));
  } while (nextPageToken && allResults.length < maxResults);
  return allResults.slice(0, maxResults);
}

// ✅ Simplified evaluation → Only care if there’s no website
async function evaluateWebsiteQuality(url) {
  if (!url) return "No Website";
  if (url.includes("facebook.com") || url.includes("instagram.com")) return "No Website";
  return "Has Website"; // ignore everything else
}

// Sweep multiple points in a city to find new businesses
const searchGridOffset = 0.03; // ~3 km offset
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

(async () => {
  await loadExistingBusinesses();

  const keywords = ["med spa", "aesthetic clinic", "laser hair removal"];

  for (const city of cities) {
    const points = generateCityGrid(city.coords);

    for (const point of points) {
      for (const keyword of keywords) {
        console.log(`\n🏙️ City: ${city.name} | Point: ${point} | 🔑 Keyword: ${keyword}`);
        const results = await searchPlaces(keyword, point, 60);
        let newCount = 0;

        for (const place of results) {
          if (newCount >= NEW_RESULTS_LIMIT) break;
          const details = await getPlaceDetails(place.place_id);
          const businessName = details.name || place.name || "Unknown";
          const address = details.formatted_address || "";
          const placeId = place.place_id;

          if (isLoggedInSearchLogCached(placeId)) continue;

          const websiteQuality = await evaluateWebsiteQuality(details.website);

          // ✅ Only keep businesses with NO website
          let addToMainTable = websiteQuality === "No Website";

          if (
            addToMainTable &&
            ((details.business_status && details.business_status !== "OPERATIONAL") ||
              (details.user_ratings_total ?? 0) < MIN_REVIEWS ||
              (details.rating ?? 5) < MIN_RATING)
          ) {
            addToMainTable = false;
          }

          if (addToMainTable) {
            await addToAirtable({
              leadName: "",
              contactProfileURL: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
              businessName,
              businessURL: details.website || "",
              cityState: address,
              phone: details.formatted_phone_number || "",
              websiteQuality,
            });
            newCount++;
          } else {
            console.log(`🌐 Skipped (${websiteQuality}): ${businessName}`);
          }

          await logBusinessSearch(businessName, address, placeId);
        }
      }
    }
  }
})();
