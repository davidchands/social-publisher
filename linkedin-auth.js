
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = 3000;

// 1. LinkedIn app settings
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = "http://127.0.0.1:3000/callback";

// 2. Find the .env file in this project's folder
const envPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".env"
);

// 3. Store a temporary security value to protect the login process
let expectedState = null;

// 4. Check that your credentials exist before starting
if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    "Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to your .env file."
  );
}

// 5. Create the LinkedIn authorization URL
app.get("/login", (req, res) => {
  expectedState = crypto.randomBytes(24).toString("hex");

  const authorizationUrl = new URL(
    "https://www.linkedin.com/oauth/v2/authorization"
  );

  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: expectedState,
    scope: "openid profile w_member_social",
  }).toString();

  res.redirect(authorizationUrl.toString());
});

// 6. LinkedIn returns the user here after authorization
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    expectedState = null;
    return res.status(400).send(
      "LinkedIn authorization was declined or failed. Check the browser URL and try again."
    );
  }

  if (
    !code ||
    typeof code !== "string" ||
    !state ||
    typeof state !== "string" ||
    !expectedState ||
    state !== expectedState
  ) {
    return res.status(400).send(
      "The authorization check failed. Please visit /login and try again."
    );
  }

  // 7. Consume the state so it cannot be reused
  expectedState = null;

  try {
    // 8. Exchange the temporary authorization code for an access token
    const response = await fetch(
      "https://www.linkedin.com/oauth/v2/accessToken",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
        }),
      }
    );

    const result = await response.json();

    console.log("Requested scopes:", "openid profile w_member_social");
    console.log("Granted scopes:", result.scope);
    console.log("Response fields:", Object.keys(result).join(", "));
    console.log("Token received:", Boolean(result.access_token));
    if (result.error) {
      console.log("LinkedIn error:", result.error, result.error_description);
    }
    
    if (!response.ok || !result.access_token) {
      console.error("LinkedIn token exchange failed:", response.status);
      return res.status(500).send(
        "Could not obtain a LinkedIn token. Check your app settings and terminal output."
      );
    }

    // 9. Update .env without printing any secrets
    let envText = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : "";

    function setEnvVariable(text, key, value) {
      const line = `${key}=${value}`;
      const pattern = new RegExp(`^${key}=.*$`, "m");

      if (pattern.test(text)) {
        return text.replace(pattern, line);
      }

      return `${text.trimEnd()}\n${line}\n`;
    }

    envText = setEnvVariable(
      envText,
      "LINKEDIN_ACCESS_TOKEN",
      result.access_token
    );

    if (result.expires_in) {
      envText = setEnvVariable(
        envText,
        "LINKEDIN_EXPIRES_IN",
        String(result.expires_in)
      );
    }

    if (result.refresh_token) {
      envText = setEnvVariable(
        envText,
        "LINKEDIN_REFRESH_TOKEN",
        result.refresh_token
      );
    }

    fs.writeFileSync(envPath, envText, { mode: 0o600 });

    // 10. Confirm success without displaying the token
    res.send(
      "LinkedIn authorization successful! Your credentials have been saved in .env. You can close this tab."
    );

    console.log("LinkedIn authorization successful. Token saved in .env.");
  } catch (err) {
    console.error("LinkedIn authorization failed:", err.message);
    res.status(500).send("Something went wrong during authorization.");
  }
});

// 11. Start the local authentication server
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Authentication server running at http://127.0.0.1:${PORT}`);
  console.log("Open http://127.0.0.1:3000/login in your browser.");
});
