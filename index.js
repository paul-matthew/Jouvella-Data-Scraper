require("dotenv").config();
const fs = require("fs");
const { google } = require("googleapis");
const axios = require("axios");
const Airtable = require("airtable");
const cities = require("./cities");

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const MIN_REVIEWS = 5;
const MIN_RATING = 3.0;
const NEW_RESULTS_LIMIT = 5;

// ✅ Google Sheets setup
const auth = new google.auth.GoogleAuth({
  keyFile: "sheets-search-log-bc033bbc638b.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ✅ Cache existing Google Sheets data
let existingPlaceIds = new Set();

async function loadExistingBusinesses() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "'Search Log'!D:D", // column D = Place ID
    });
    const placeIds = res.data.values ? res.data.values.flat() : [];
    existingPlaceIds = new Set(placeIds.filter(Boolean));
    console.log(`ℹ️ Loaded ${existingPlaceIds.size} existing Place IDs from Google Sheets`);
  } catch (err) {
    console.error("❌ Error reading Google Sheets:", err.message);
    existingPlaceIds = new Set();
  }
}

// ✅ Check if place_id exists
function isLoggedInSearchLogCached(placeId) {
  return existingPlaceIds.has(placeId);
}

// ✅ Log a business in Google Sheets and update cache
async function logBusinessSearch(businessName, address, placeId) {
  try {
    if (isLoggedInSearchLogCached(placeId)) {
      console.log(`ℹ️ Already logged in Google Sheets: ${businessName}`);
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "'Search Log'!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [businessName, address, new Date().toISOString().split("T")[0], placeId],
        ],
      },
    });

    existingPlaceIds.add(placeId);
    console.log(`📝 Logged in Google Sheets: ${businessName}`);
  } catch (err) {
    console.error(`❌ Error logging business in Google Sheets: ${err.message}`);
  }
}

// ✅ Airtable Duplicate Check
async function isDuplicate(businessName) {
  try {
    const records = await base(process.env.AIRTABLE_TABLE_NAME)
      .select({
        filterByFormula: `{Business Name} = "${businessName}"`,
        maxRecords: 1,
      })
      .firstPage();
    return records.length > 0;
  } catch (err) {
    console.error("❌ Error checking duplicates:", err.message);
    return false;
  }
}

// ✅ Add business to Airtable
async function addToAirtable(data) {
  try {
    if (await isDuplicate(data.businessName)) {
      console.log(`❌ Skipped duplicate in Airtable: ${data.businessName}`);
      return;
    }

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
        },
      },
    ]);

    console.log(`✅ Added to Airtable: ${data.businessName}`);
  } catch (err) {
    console.error(`❌ Error adding business to Airtable: ${err.message}`);
  }
}

// ✅ Fetch place details
async function getPlaceDetails(placeId) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,website,formatted_phone_number,user_ratings_total,rating,business_status&key=${process.env.GOOGLE_API_KEY}`;
    const res = await axios.get(url);

    if (res.data.error_message) throw new Error(res.data.error_message);

    return res.data.result || {};
  } catch (err) {
    console.error("❌ Error fetching place details:", err.message);
    return {};
  }
}

// ✅ Paginated search
async function searchPlaces(query, location, radius = 5000, maxResults = 60) { //max searches
  let allResults = [];
  let nextPageToken = null;

  do {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&location=${location}&radius=${radius}&key=${
      process.env.GOOGLE_API_KEY
    }${nextPageToken ? `&pagetoken=${nextPageToken}` : ""}`;

    const res = await axios.get(url);
    if (res.data.error_message) throw new Error(res.data.error_message);

    allResults = allResults.concat(res.data.results || []);
    nextPageToken = res.data.next_page_token;

    if (nextPageToken) await new Promise(resolve => setTimeout(resolve, 2000));
  } while (nextPageToken && allResults.length < maxResults);

  return allResults.slice(0, maxResults);
}

// ✅ Check if website is poor
async function isWebsiteLowBudget(url) {
  try {
    if (!url) return true;
    if (!url.startsWith("https://")) return true;

    const freePlatforms = ["wixsite.com", "weebly.com", "wordpress.com"];
    if (freePlatforms.some(p => url.includes(p))) return true;

    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data || res.data.length < 2000) return true;

    return false;
  } catch {
    return true;
  }
}

// ✅ Main flow
(async () => {
  try {
    console.log("🚀 Searching for med spas in multiple cities...");
    await loadExistingBusinesses();

    const keywords = ["med spa", "aesthetic clinic", "laser hair removal"];

    for (const city of cities) {
      for (const keyword of keywords) {
        console.log(`\n🏙️ City: ${city.name} | 🔑 Keyword: ${keyword}`);
        const results = await searchPlaces(keyword, city.coords, 5000, 60); //max searches

        console.log(`🔎 Found ${results.length} places for "${keyword}" in ${city.name}`);

        let newCount = 0;

        for (const place of results) {
          if (newCount >= NEW_RESULTS_LIMIT) break;

          const details = await getPlaceDetails(place.place_id);
          const businessName = details.name || place.name || "Unknown";
          const address = details.formatted_address || place.formatted_address || "";
          const placeId = place.place_id;

          if (isLoggedInSearchLogCached(placeId)) {
            console.log(`ℹ️ Already processed: ${businessName}`);
            continue;
          }

          let addToMainTable = false;
          if (!details.website) {
            addToMainTable = true;
          } else if (await isWebsiteLowBudget(details.website)) {
            addToMainTable = true;
            console.log(`⚠️ LowBudget website detected: ${businessName} | ${details.website}`);
          } else {
            console.log(`🌐 Skipped (good website): ${businessName}`);
          }

          if (
            addToMainTable &&
            ((details.business_status && details.business_status !== "OPERATIONAL") ||
              (details.user_ratings_total === undefined || details.user_ratings_total < MIN_REVIEWS) ||
              (details.rating !== undefined && details.rating < MIN_RATING))
          ) {
            console.log(`⚠️ Skipped (inactive / low reviews / low rating): ${businessName}`);
            addToMainTable = false;
          }

          if (addToMainTable) {
            await addToAirtable({
              leadName: "",
              contactProfileURL: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
              businessName: businessName,
              businessURL: details.website || "",
              cityState: address,
              phone: details.formatted_phone_number || "",
            });
            newCount++;
          }

          await logBusinessSearch(businessName, address, placeId);
        }

        console.log(`✅ Added ${newCount} new businesses for "${keyword}" in ${city.name}`);
      }
    }
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
  }
})();









