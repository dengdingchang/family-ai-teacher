(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FamilyDailyGuidance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const clean = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    valueForForm(profile) {
      return profile?.daily_guidance_active === true ? clean(profile.daily_guidance) : "";
    },
    patchForSave(value) {
      return { daily_guidance: clean(value) };
    },
  };
});
