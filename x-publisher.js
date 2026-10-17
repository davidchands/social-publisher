
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";

// ==================================================
// 1. CONFIGURATION
// ==================================================

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const POSTS_URL = "https://api.x.com/2/tweets";
const MEDIA_URL = "https://api.x.com/2/media/upload";

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;

// ==================================================
// 2. SAVE UPDATED TOKENS
// ==================================================

async function saveTokensToEnv(tokens) {
  const envPath = path.resolve(process.cwd(), ".env");

  // Read the existing .env file so we preserve your Slack settings.
  const lines = (await fs.readFile(envPath, "utf8")).split(/\r?\n/);

  // Prepare only the OAuth 2.0 values that need updating.
  const values = {
    X_OAUTH2_ACCESS_TOKEN: tokens.access_token,
  };

  // X may return a replacement refresh token.
  if (tokens.refresh_token) {
    values.X_OAUTH2_REFRESH_TOKEN = tokens.refresh_token;
  }

  if (tokens.expires_in !== undefined) {
    values.X_OAUTH2_EXPIRES_IN = String(tokens.expires_in);
  }

  // Update existing lines or append missing variables.
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));

    if (index >= 0) {
      lines[index] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }

    // Make the updated values available to this running process.
    process.env[key] = String(value);
  }

  // Write the updated file without logging any tokens.
  await fs.writeFile(envPath, lines.join("\n").replace(/\n*$/, "\n"), {
    mode: 0o600,
  });

  await fs.chmod(envPath, 0o600).catch(() => {});
}

// ==================================================
// 3. REFRESH THE ACCESS TOKEN
// ==================================================

// Reload the saved tokens: X refresh tokens work only once, and another
// process (such as x-auth.js) may have saved newer ones since startup.
async function loadSavedTokens() {
  const saved = dotenv.parse(
    await fs.readFile(path.resolve(process.cwd(), ".env"), "utf8").catch(() => "")
  );

  for (const key of ["X_OAUTH2_ACCESS_TOKEN", "X_OAUTH2_REFRESH_TOKEN"]) {
    if (saved[key]) {
      process.env[key] = saved[key];
    }
  }
}

async function refreshAccessToken() {
  await loadSavedTokens();

  if (
    !CLIENT_ID ||
    !CLIENT_SECRET ||
    !process.env.X_OAUTH2_REFRESH_TOKEN
  ) {
    throw new Error(
      "OAuth 2.0 credentials are missing. Run node x-auth.js first."
    );
  }

  // Ask X for a new access token using the saved refresh token.
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.X_OAUTH2_REFRESH_TOKEN,
  });

  const response = await fetch(TOKEN_URL, {
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
  });

  if (!response.ok) {
    throw new Error(
      `X token refresh failed with HTTP ${response.status}. You may need to authorize again using node x-auth.js.`
    );
  }

  const tokens = await response.json();

  if (!tokens.access_token) {
    throw new Error("X did not return a new access token.");
  }

  // Save the new access token and any replacement refresh token.
  await saveTokensToEnv(tokens);

  return tokens.access_token;
}

// ==================================================
// 4. SEND A REQUEST, REFRESHING THE TOKEN IF NEEDED
// ==================================================

// makeInit builds fresh request options each time, because a request
// body (such as an upload chunk) cannot be sent twice.
async function xRequest(url, makeInit) {
  await loadSavedTokens();

  let accessToken = process.env.X_OAUTH2_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error(
      "No OAuth 2.0 access token found. Run node x-auth.js first."
    );
  }

  let response = await fetch(url, makeInit(accessToken));

  // If X says the access token is unauthorized, refresh it and retry once.
  if (response.status === 401) {
    accessToken = await refreshAccessToken();
    response = await fetch(url, makeInit(accessToken));
  }

  return response;
}

function jsonInit(method, body) {
  return (accessToken) => ({
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ==================================================
// 5. UPLOAD AN IMAGE OR VIDEO TO X
// ==================================================

const CHUNK_SIZE = 4 * 1024 * 1024;

// X needs to know what kind of media it is receiving.
function mediaCategory(mediaType) {
  if (mediaType === "image/gif") return "tweet_gif";
  if (mediaType.startsWith("image/")) return "tweet_image";
  return "tweet_video";
}

async function uploadMedia(mediaPath, mediaType = "video/mp4") {
  const fileBuffer = await fs.readFile(mediaPath);

  // 5a. Register the upload.
  const initResponse = await xRequest(
    `${MEDIA_URL}/initialize`,
    jsonInit("POST", {
      media_type: mediaType,
      total_bytes: fileBuffer.length,
      media_category: mediaCategory(mediaType),
    })
  );

  if (!initResponse.ok) {
    throw new Error(
      `X media upload could not start (HTTP ${initResponse.status}): ${await initResponse.text()}`
    );
  }

  const mediaId = (await initResponse.json()).data.id;

  // 5b. Upload the file in chunks.
  for (let offset = 0, index = 0; offset < fileBuffer.length; offset += CHUNK_SIZE, index++) {
    const chunk = fileBuffer.subarray(offset, offset + CHUNK_SIZE);

    const appendResponse = await xRequest(
      `${MEDIA_URL}/${mediaId}/append`,
      (accessToken) => {
        const form = new FormData();
        form.append("segment_index", String(index));
        form.append("media", new Blob([chunk]), "media");

        return {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        };
      }
    );

    if (!appendResponse.ok) {
      throw new Error(
        `X media chunk upload failed (HTTP ${appendResponse.status}): ${await appendResponse.text()}`
      );
    }
  }

  // 5c. Tell X every chunk has been uploaded.
  const finalizeResponse = await xRequest(
    `${MEDIA_URL}/${mediaId}/finalize`,
    jsonInit("POST")
  );

  if (!finalizeResponse.ok) {
    throw new Error(
      `X media upload could not finish (HTTP ${finalizeResponse.status}): ${await finalizeResponse.text()}`
    );
  }

  let processing = (await finalizeResponse.json()).data?.processing_info;

  // 5d. Wait for X to finish processing the media.
  while (processing && processing.state !== "succeeded") {
    if (processing.state === "failed") {
      throw new Error(
        `X could not process the media: ${processing.error?.message ?? "unknown reason"}`
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, (processing.check_after_secs ?? 5) * 1000)
    );

    const statusResponse = await xRequest(
      `${MEDIA_URL}?command=STATUS&media_id=${mediaId}`,
      jsonInit("GET")
    );

    if (!statusResponse.ok) {
      throw new Error(
        `X media status check failed (HTTP ${statusResponse.status}): ${await statusResponse.text()}`
      );
    }

    processing = (await statusResponse.json()).data?.processing_info;
  }

  return mediaId;
}

// ==================================================
// 6. PUBLISH A POST TO X
// ==================================================

// Pass { mediaPath, mediaType } to attach a local image or video file.
export async function publishToX(postText, { mediaPath, mediaType } = {}) {
  // Reject empty posts before making an API request.
  if (!postText || !postText.trim()) {
    throw new Error("The post cannot be empty.");
  }

  // Upload the image or video first, if there is one.
  const body = { text: postText.trim() };

  if (mediaPath) {
    body.media = { media_ids: [await uploadMedia(mediaPath, mediaType)] };
  }

  const response = await xRequest(POSTS_URL, jsonInit("POST", body));

  // Report API errors without printing credentials.
  if (!response.ok) {
    throw new Error(
      `X publishing failed with HTTP ${response.status}: ${await response.text()}`
    );
  }

  // Return the published post's details to the Slack bot.
  const result = await response.json();

  return result.data;
}
