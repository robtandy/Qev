/** Explicit experimental boundary, not a claim of screen-only/human-equivalent perception. */
export const DEFAULT_ASSISTANCE = "assisted";
export const ASSISTANCE = Object.freeze({
  assisted: Object.freeze({
    label: "Assistance on",
    observationPolicy: "Engine-labelled, view-cone/LOS-filtered actors, exact coordinates, and privileged local geometry/cover probes; not pixel-derived perception.",
    controller: "Geometry/GPS-assisted offers, tactical shortlisting, target tracking and aim-gated fire. 200 units/s movement, up to 180 deg/s aim; 60 Hz, bounded input leases.",
    note: "On: geometry/GPS, aim and tactical offers. Priorities change the prompt, not those aids.",
  }),
  unassisted: Object.freeze({
    label: "Assistance off",
    observationPolicy: "HUD and coarse engine-labelled visible-object descriptions only, not pixels/audio. No coordinates, actor IDs, geometry probes, or GPS memory. Visibility is approximate, not guaranteed human perception.",
    controller: "Fixed relative movement/look/fire inputs, no probes, target tracking, aim-gated fire, hazard vetoes, navigation memory or tactical shortlisting. 200 units/s, 60 deg/s turn, 45 deg/s look; 60 Hz, bounded input leases. No jump/swim/weapon-selection inputs in this experiment.",
    note: "Off: HUD + coarse visible-object labels, not pixels/audio. No probes, GPS, aim or tactical filtering; walls/hazards are unknown.",
  }),
});
export function validateAssistance(value) {
  if (value !== "assisted" && value !== "unassisted") throw new Error("Invalid assistance mode.");
  return value;
}
export function assistanceOf(observation) {
  // Older diagnostic fixtures omit the field. The production engine must export the mode API.
  return validateAssistance(observation.assistance === undefined ? DEFAULT_ASSISTANCE : observation.assistance);
}
