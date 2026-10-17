
import "dotenv/config";
import { publishToLinkedIn } from "./linkedin-publisher.js";

const message = `Testing my LinkedIn publishing integration. (${new Date().toLocaleString()})`;

try {
  const result = await publishToLinkedIn(message);
  console.log(result.message);
  console.log("Post ID:", result.postId);
} catch (error) {
  console.error(error.message);
}
