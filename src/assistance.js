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
    observationPolicy: "HUD plus renderer-labelled visible pixels: 2D extents, apparent size, aim-center overlap and cautious short-lived image-size trends. Engine labels/corpse filtering remain a concession; this is not RGB-only vision or human-equivalent perception. No world coordinates, actor IDs, engine range bins, depth-buffer distances, geometry probes or GPS memory. Visible extent is not full extent; metric depth, occlusion fraction and unseen space are unknown.",
    controller: "Fixed relative movement/look/fire inputs, no probes, target tracking, aim-gated fire, hazard vetoes, navigation memory or tactical shortlisting. 200 units/s, 60 deg/s turn, 45 deg/s look; 60 Hz, bounded input leases. No jump/swim/weapon-selection inputs in this experiment.",
    note: "Off: visible-pixel size/aim cues + engine labels, not RGB-only vision. Depth uncertain; no probes, GPS, auto-aim or tactical filtering.",
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
