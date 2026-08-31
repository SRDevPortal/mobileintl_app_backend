const express = require("express");

const { getUserContextForApi } = require("../services/userService");

const router = express.Router();

function truthyFlag(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true"
  );
}

function pickProfile(data) {
  if (data?.profile && typeof data.profile === "object") return data.profile;
  if (
    Array.isArray(data?.profiles) &&
    data.profiles[0] &&
    typeof data.profiles[0] === "object"
  ) {
    return data.profiles[0];
  }
  if (
    Array.isArray(data?.user?.profiles) &&
    data.user.profiles[0] &&
    typeof data.user.profiles[0] === "object"
  ) {
    return data.user.profiles[0];
  }
  return null;
}

function pickSelectedDisease(data, profile) {
  const diseaseSelection = data?.disease_selection;
  if (diseaseSelection && typeof diseaseSelection === "object") {
    const name =
      diseaseSelection.disease_name ||
      diseaseSelection.title ||
      diseaseSelection.name;
    if (name != null && String(name).trim()) return String(name).trim();
  }

  for (const key of [
    "disease",
    "disease_name",
    "selected_disease",
    "selectedDisease",
  ]) {
    const value = profile?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function buildStartupDecision(data) {
  const profile = pickProfile(data);
  const profileComplete = truthyFlag(profile?.profile_complete);
  // Profile completion is mandatory before any app access. The stored force
  // flag is advisory and must never turn an incomplete profile into dashboard
  // access.
  const forceProfileSetup = !profileComplete;
  const selectedDisease = pickSelectedDisease(data, profile);

  return {
    profile_complete: profileComplete,
    force_profile_setup: forceProfileSetup,
    selected_disease: selectedDisease,
    should_open: profileComplete ? "dashboard" : "profile_setup",
  };
}

router.get("/", async (req, res) => {
  try {
    const data = await getUserContextForApi(req.query || {});
    if (!data?.user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
        data: {
          should_open: "login",
          profile_complete: false,
          force_profile_setup: false,
          selected_disease: "",
        },
      });
    }

    const decision = buildStartupDecision(data);
    return res.json({
      success: true,
      data: {
        ...data,
        ...decision,
      },
    });
  } catch (e) {
    return res
      .status(e.status || 500)
      .json({ success: false, message: e.message });
  }
});

module.exports = router;
