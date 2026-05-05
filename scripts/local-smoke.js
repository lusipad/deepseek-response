const baseUrl = process.env.DEEPSEEK2RESPONSE_URL || "http://127.0.0.1:18488/v1";

const response = await fetch(`${baseUrl}/responses`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer local-smoke"
  },
  body: JSON.stringify({
    model: process.env.DEEPSEEK_MODEL || "deepseek-auto",
    input: "只回复 OK",
    stream: false
  })
});

const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));

if (!response.ok || payload.status !== "completed") {
  process.exitCode = 1;
}
