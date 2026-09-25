// Only fixed messages cross the API boundary; upstream tracebacks may contain
// internal paths, credentials or patient information.
function aiChatErrorResponse(error = {}) {
  error = error || {};
  const payload = error.payload || {};
  const diagnostic = [error.message, payload.message, payload.exc, payload._server_messages,
    payload._error_message, payload.exc_type].map((value) => {
    try { return typeof value === "string" ? value : JSON.stringify(value); }
    catch (_) { return ""; }
  }).join(" ");
  const response = (status, code, message) => ({ status, body: { success: false, code, message } });

  if (error.code === "LIMIT_FILE_SIZE") {
    return response(413, "ATTACHMENT_TOO_LARGE", "Choose an attachment smaller than 25 MB.");
  }
  if (error.name === "MulterError") {
    return response(400, "INVALID_ATTACHMENT", "Choose one attachment and try again.");
  }
  if (/Message is required\./.test(diagnostic)) {
    return response(400, "CHAT_MESSAGE_REQUIRED", "Type a message before sending.");
  }
  if (/Message cannot exceed 4000 characters\./.test(diagnostic)) {
    return response(400, "CHAT_MESSAGE_TOO_LONG", "Keep your message within 4,000 characters.");
  }
  if (/Client message ID is required\./.test(diagnostic)) {
    return response(400, "CHAT_MESSAGE_ID_REQUIRED", "Please reopen the chat and try sending again.");
  }
  if (/Invalid backend token|ERP.*token.*not configured|MOBILE_APP_ERP_TOKEN|AuthenticationError/i.test(diagnostic)
      || Number(error.status) === 401) {
    return response(503, "CHAT_UNAVAILABLE", "Chat is temporarily unavailable. Please try again later.");
  }
  if (/Conversation was not found|selected conversation does not match/i.test(diagnostic)) {
    return response(403, "CHAT_ACCESS_DENIED", "We couldn't open this chat for your selected profile. Please check your profile or contact the care team.");
  }
  if (/selected profile does not belong|Select a patient profile/i.test(diagnostic)) {
    return response(422, "CHAT_PROFILE_REQUIRED", "Select a patient profile linked to your account to continue.");
  }
  if (/verified mobile number|valid phone number including its country code|No mobile number found for Patient/i.test(diagnostic)) {
    return response(422, "CHAT_PHONE_REQUIRED", "Your app or patient profile needs a valid phone number with its country code. Please update your profile or contact the care team.");
  }
  if (/Mobile App User was not found|Mobile App User is inactive/i.test(diagnostic)) {
    return response(403, "CHAT_ACCOUNT_UNAVAILABLE", "We couldn't access your app account. Please sign in again or contact the care team.");
  }
  if (Number(error.status) === 403) {
    return response(403, "CHAT_ACCESS_DENIED", "You don't have access to this chat. Please contact the care team.");
  }
  if (Number(error.status) === 429) {
    return response(429, "CHAT_RATE_LIMITED", "Too many requests. Please wait a moment and try again.");
  }
  return response(Number(error.status) === 503 ? 503 : 502, "CHAT_UNAVAILABLE",
    "Chat is temporarily unavailable. Please try again later or contact the care team.");
}

module.exports = { aiChatErrorResponse };
