import { query } from "../db.js";

export async function requireOnboardingUnlocked(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT "onboardingPaidAt", "onboardingWaived"
       FROM "AgentProfile" WHERE "userId" = $1`,
      [req.user.id]
    );

    const paid = !!rows?.[0]?.onboardingPaidAt;
    const waived = !!rows?.[0]?.onboardingWaived;

    if (paid || waived) return next();

    return res
      .status(403)
      .json({ error: "Complete onboarding payment (or be approved) to proceed." });
  } catch (err) {
    console.error("requireOnboardingUnlocked failed:", err);
    return res.status(500).json({ error: "Server error checking onboarding status" });
  }
}
