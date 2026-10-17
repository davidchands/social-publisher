
import "dotenv/config";
import { Client, OAuth1 } from "@xdevplatform/xdk";

// Build the OAuth 1.0a authentication using your X credentials.
const oauth1 = new OAuth1({
  apiKey: process.env.X_API_KEY,
  apiSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

// Create an X API client that acts on your authenticated account.
const client = new Client({ oauth1 });

async function testXConnection() {
  try {
    // Ask X which account these credentials belong to.
    const response = await client.users.getMe();

    console.log("X authentication successful!");
    console.log("Account:", response.data?.username);
  } catch (error) {
    // Show the error without printing your credentials.
    console.error("X authentication failed.");
    console.error(error.message);
  }
}

testXConnection();
