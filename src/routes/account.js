const express = require("express");

const { erpCallMethod } = require("../frappeClient");
const { findMobileAppUser } = require("../services/userService");
const { deleteSupabaseUser } = require("../supabaseAuth");

const router = express.Router();

router.delete("/", async (req, res) => {
  try {
    const uid = req.authUser?.id;
    if (!uid) {
      return res.status(403).json({ success: false, message: "User authentication is required" });
    }
    if (req.body?.confirmation !== "DELETE") {
      return res.status(400).json({ success: false, message: "Type DELETE to confirm account deletion" });
    }

    const user = await findMobileAppUser({ external_id: uid, supabase_user_id: uid }, {}, {});
    const identity = user?.name || uid;
    const erpResult = await erpCallMethod("mobileintl_app.api.v1.users_delete", {
      method: "POST",
      body: { external_id: identity, supabase_user_id: uid },
      appToken: true,
    });
    const deleted = erpResult?.message?.data?.deleted || erpResult?.data?.deleted || {};

    await deleteSupabaseUser(uid);
    return res.json({ success: true, data: { deleted } });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

module.exports = router;
