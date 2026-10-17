import "dotenv/config";
import fs from "node:fs/promises";

const LINKEDIN_VERSION = "202610";

// 1. Headers shared by LinkedIn's versioned REST API.
function restHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// 2. Read the token saved by linkedin-auth.js.
function getAccessToken() {
  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error(
      "LinkedIn access token missing. Run node linkedin-auth.js first."
    );
  }

  return accessToken;
}

// 3. Ask LinkedIn who the authenticated member is.
async function getAuthor(accessToken) {
  const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const profile = await profileResponse.json();

  if (!profileResponse.ok || !profile.sub) {
    throw new Error(
      `Could not identify LinkedIn member (${profileResponse.status}). Reauthorize if the token is invalid.`
    );
  }

  return `urn:li:person:${profile.sub}`;
}

// 4. Upload a local video file and wait until LinkedIn has processed it.
async function uploadVideo(accessToken, author, videoPath) {
  const fileBuffer = await fs.readFile(videoPath);

  // 4a. Register the upload and get the upload URLs.
  const initResponse = await fetch(
    "https://api.linkedin.com/rest/videos?action=initializeUpload",
    {
      method: "POST",
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: author,
          fileSizeBytes: fileBuffer.length,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    }
  );

  if (!initResponse.ok) {
    throw new Error(
      `LinkedIn video upload could not start (${initResponse.status}): ${await initResponse.text()}`
    );
  }

  const { value } = await initResponse.json();
  const etags = [];

  // 4b. Upload each part of the file to its own URL.
  for (const instruction of value.uploadInstructions) {
    const chunk = fileBuffer.subarray(
      instruction.firstByte,
      instruction.lastByte + 1
    );

    const partResponse = await fetch(instruction.uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    });

    if (!partResponse.ok) {
      throw new Error(
        `LinkedIn video part upload failed (${partResponse.status}).`
      );
    }

    etags.push(partResponse.headers.get("etag"));
  }

  // 4c. Tell LinkedIn every part has been uploaded.
  const finalizeResponse = await fetch(
    "https://api.linkedin.com/rest/videos?action=finalizeUpload",
    {
      method: "POST",
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: value.video,
          uploadToken: value.uploadToken ?? "",
          uploadedPartIds: etags,
        },
      }),
    }
  );

  if (!finalizeResponse.ok) {
    throw new Error(
      `LinkedIn video upload could not finish (${finalizeResponse.status}): ${await finalizeResponse.text()}`
    );
  }

  // 4d. Wait (up to 10 minutes) for LinkedIn to process the video.
  const statusUrl = `https://api.linkedin.com/rest/videos/${encodeURIComponent(value.video)}`;

  for (let attempt = 0; attempt < 120; attempt++) {
    const statusResponse = await fetch(statusUrl, {
      headers: restHeaders(accessToken),
    });
    const video = await statusResponse.json();

    if (video.status === "AVAILABLE") {
      return value.video;
    }

    if (video.status === "PROCESSING_FAILED") {
      throw new Error(
        `LinkedIn could not process the video: ${video.processingFailureReason ?? "unknown reason"}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("LinkedIn took too long to process the video.");
}

// 5. Upload a local image file (JPG, PNG or GIF).
async function uploadImage(accessToken, author, imagePath) {
  // 5a. Register the upload and get the upload URL.
  const initResponse = await fetch(
    "https://api.linkedin.com/rest/images?action=initializeUpload",
    {
      method: "POST",
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        initializeUploadRequest: { owner: author },
      }),
    }
  );

  if (!initResponse.ok) {
    throw new Error(
      `LinkedIn image upload could not start (${initResponse.status}): ${await initResponse.text()}`
    );
  }

  const { value } = await initResponse.json();

  // 5b. Upload the image itself.
  const uploadResponse = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: await fs.readFile(imagePath),
  });

  if (!uploadResponse.ok) {
    throw new Error(`LinkedIn image upload failed (${uploadResponse.status}).`);
  }

  // 5c. Wait (up to 1 minute) until LinkedIn has the image ready.
  const statusUrl = `https://api.linkedin.com/rest/images/${encodeURIComponent(value.image)}`;

  for (let attempt = 0; attempt < 30; attempt++) {
    const statusResponse = await fetch(statusUrl, {
      headers: restHeaders(accessToken),
    });
    const image = await statusResponse.json();

    if (image.status === "AVAILABLE") {
      return value.image;
    }

    if (image.status === "PROCESSING_FAILED") {
      throw new Error("LinkedIn could not process the image.");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("LinkedIn took too long to process the image.");
}

// 6. Publish a post to the authenticated member's profile.
//    Pass { mediaPath, mediaType } to attach a local image or video file.
export async function publishToLinkedIn(postText, { mediaPath, mediaType } = {}) {
  // 7. Prevent empty posts.
  if (!postText || !postText.trim()) {
    throw new Error("The LinkedIn post cannot be empty.");
  }

  const accessToken = getAccessToken();
  const author = await getAuthor(accessToken);

  // 8. Upload the image or video first, if there is one.
  let content;

  if (mediaPath) {
    const mediaId = mediaType?.startsWith("image/")
      ? await uploadImage(accessToken, author, mediaPath)
      : await uploadVideo(accessToken, author, mediaPath);

    content = { media: { id: mediaId } };
  }

  // 9. Create the post using LinkedIn's Posts API.
  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: restHeaders(accessToken),
    body: JSON.stringify({
      author,
      commentary: postText.trim(),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      ...(content && { content }),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  // 10. Read LinkedIn's response.
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `LinkedIn publishing failed (${response.status}): ${responseText}`
    );
  }

  // 11. Return the ID of the created post.
  return {
    postId: response.headers.get("x-restli-id"),
    message: "Successfully published to LinkedIn!",
  };
}
