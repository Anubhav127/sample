/**
 * uninstall.js
 * Verifies the uninstall password submitted by the Burn BA wizard.
 * Password hash is hardcoded — change this hash when you change the password.
 *
 * To generate a new hash:
 *   node -e "require('bcrypt').hash('yourpassword', 12).then(console.log)"
 *
 * Current password : Admin@1234
 */

const { Router } = require("express");
const bcrypt = require("bcrypt");
const attemptGuard = require("../middleware/attemptGuard");

const router = Router();

const UNINSTALL_PASSWORD_HASH =
  "$2b$12$fPxzV8S1OUhwnr0VF.6FDO8dwgQP2DFavt9Yjn2Jtd7JGnmFUueny";

router.post("/", attemptGuard, async (req, res) => {
  const { password } = req.body;

  if (!password || typeof password !== "string") {
    return res.status(400).json({
      success: false,
      attemptsRemaining: req.attemptGuard.remaining(),
      message: "Password is required.",
    });
  }

  try {
    const match = await bcrypt.compare(password, UNINSTALL_PASSWORD_HASH);

    if (match) {
      console.log(
        `[UNINSTALL] Password verified successfully from IP: ${req.ip} at ${new Date().toISOString()}`
      );
      return res.status(200).json({
        success: true,
        attemptsRemaining: req.attemptGuard.remaining(),
        message: "Password verified. Uninstallation authorized.",
      });
    }

    // Wrong password — increment attempt count
    const totalAttempts = req.attemptGuard.increment();
    const remaining = req.attemptGuard.remaining();

    console.warn(
      `[UNINSTALL] Failed attempt ${totalAttempts}/${3} from IP: ${req.ip} at ${new Date().toISOString()}`
    );

    if (remaining === 0) {
      console.warn(`[UNINSTALL] IP ${req.ip} is now locked out.`);
      return res.status(403).json({
        success: false,
        attemptsRemaining: 0,
        message: "Maximum attempts exceeded. Contact your administrator.",
      });
    }

    return res.status(401).json({
      success: false,
      attemptsRemaining: remaining,
      message: `Incorrect password. ${remaining} attempt(s) remaining.`,
    });
  } catch (err) {
    console.error("[UNINSTALL] Error during password verification:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error during verification.",
    });
  }
});

module.exports = router;
