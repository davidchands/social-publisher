
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ==================================================
// 1. BASIC CONFIGURATION
// ==================================================

const app = express();
const PORT = 3000;

// This must exactly match the callback URL in your X Developer Portal.
const REDIRECT_URI = "http://127.0.0.1:3000/callback";

// X permissions needed to read your account and publish posts.
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
];

// Make sure the Client ID and Client Secret exist in .env.
const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    "Missing X_CLIENT_ID or X_CLIENT_SECRET in your .env file."
  );
}

// These temporary values are used to protect the login process.
let savedState = null;
let savedCodeVerifier = null;


// ==================================================
// 2. SAVE TOKENS TO .ENV
// ==================================================

async function saveTokensToEnv(tokens) {
  const envPath = path.resolve(process.cwd(), ".env");

  // Read the existing file so we don't remove your Slack settings.
  let lines = (await fs.readFile(envPath, "utf8")).split(/\r?\n/);

  // Save OAuth 2.0 tokens under separate names from your OAuth 1.0 keys.
  const values = {
    X_OAUTH2_ACCESS_TOKEN: tokens.access_token,
    X_OAUTH2_REFRESH_TOKEN: tokens.refresh_token,
    X_OAUTH2_EXPIRES_IN: String(tokens.expires_in ?? ""),
  };

  // Update existing entries or add new ones.
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    const newLine = `${key}=${value}`;

    if (index >= 0) {
      lines[index] = newLine;
    } else {
      lines.push(newLine);
    }
  }

  // Write the updated .env file without printing any secrets.
  await fs.writeFile(envPath, lines.join("\n").replace(/\n*$/, "\n"), {
    mode: 0o600,
  });

  // Restrict file permissions on macOS/Linux where supported.
  await fs.chmod(envPath, 0o600).catch(() => {});
}


// ==================================================
// 3. START THE X AUTHORIZATION PROCESS
// ==================================================

app.get("/login", (req, res) => {
  // Generate a random value to protect the callback from forged requests.
  savedState = crypto.randomBytes(32).toString("hex");

  // Generate a secret verifier for PKCE.
  savedCodeVerifier = crypto.randomBytes(32).toString("base64url");

  // X requires a SHA-256 challenge derived from that verifier.
  const codeChallenge = crypto
    .createHash("sha256")
    .update(savedCodeVerifier)
    .digest("base64url");

  // Build the URL that sends you to X to approve access.
  const authorizationURL = new URL(
    "https://x.com/i/oauth2/authorize"
  );

  authorizationURL.searchParams.set("response_type", "code");
  authorizationURL.searchParams.set("client_id", CLIENT_ID);
  authorizationURL.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizationURL.searchParams.set("scope", SCOPES.join(" "));
  authorizationURL.searchParams.set("state", savedState);
  authorizationURL.searchParams.set("code_challenge", codeChallenge);
  authorizationURL.searchParams.set("code_challenge_method", "S256");

  // Redirect your browser to X's authorization page.
  res.redirect(authorizationURL.toString());
});


// ==================================================
// 4. HANDLE X'S CALLBACK AND EXCHANGE THE CODE
// ==================================================

app.get("/callback", async (req, res) => {
  try {
    // X may redirect back with an error if authorization was denied.
    if (req.query.error) {
      return res.status(400).send(
        "X authorization was not completed. You can close this tab."
      );
    }

    const { code, state } = req.query;

    // Check that the callback matches the login attempt we started.
    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !savedState ||
      state !== savedState ||
      !savedCodeVerifier
    ) {
      return res.status(400).send(
        "Authorization could not be verified. Restart the login process."
      );
    }

    // Consume the temporary values so this callback can't be reused.
    const codeVerifier = savedCodeVerifier;
    savedState = null;
    savedCodeVerifier = null;

    // Prepare the authorization code exchange.
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    });

    // Exchange the temporary code for OAuth 2.0 tokens.
    const tokenResponse = await fetch(
      "https://api.x.com/2/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(
              `${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`
            ).toString("base64"),
        },
        body: form,
      }
    );

    if (!tokenResponse.ok) {
      // Show the HTTP status, but never print your credentials or tokens.
      console.error(
        "X token exchange failed. HTTP status:",
        tokenResponse.status
      );

      return res.status(502).send(
        "X did not accept the token exchange. Check the terminal for the HTTP status and verify your X app settings."
      );
    }

    const tokens = await tokenResponse.json();

    if (!tokens.access_token) {
      return res.status(502).send(
        "X did not return an access token. Check the terminal."
      );
    }

    // Save the tokens locally so the publisher can use them next.
    await saveTokensToEnv(tokens);

    console.log("X authorization completed. OAuth 2.0 tokens saved to .env.");

    return res.send(
      "Authorization successful! Your X tokens have been saved to .env. You can close this browser tab and return to your terminal."
    );
  } catch (error) {
    console.error("Authorization process failed:", error.message);

    return res.status(500).send(
      "Something went wrong during authorization. Check the terminal for the error."
    );
  }
});


// ==================================================
// 5. RUN THE LOCAL AUTHORIZATION SERVER
// ==================================================

app.listen(PORT, "127.0.0.1", () => {
  console.log("Local X authorization server is running.");
  console.log(`Open this URL in your browser: http://127.0.0.1:${PORT}/login`);
});
