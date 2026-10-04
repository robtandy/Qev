// Only this freely licensed, pinned bundle is eligible for automatic loading/hosting.
// Qev is demo-only: there is no custom game-data import path.
export const DEMO = {
  id: "librequake-v0.09-beta-lite-qev-v1",
  title: "LibreQuake · Episode Zero",
  map: "lq_e0m6",
  source: "https://github.com/lavenderdotpet/LibreQuake/tree/v0.09-beta",
  files: [
    { name: "pak0.pak", size: 43948916, sha256: "0dd895a425e75d9908025dcfe340f75f5b8166ada68b2d7ee54d8d91d29378ff" },
    { name: "pak1.pak", size: 5856792, sha256: "28423c01836341d9e3c6465b407a44ae94e4e29e954544a67739686850e39365" },
    { name: "pak2.pak", size: 1753679, sha256: "19dfa208b4ca19820d3be1c9b7087841497b0d037f8435902c753d6450bd24d4" },
  ],
  notice: { name: "NOTICE.txt", size: 59397, sha256: "248913f767f13c1e760679cd3806fa0e7de207cae434a7ebdc6b152f11297399" },
};
// Presentation only: no coordinates, exit locations, routes, or hidden actor data.
export const DEMO_MAPS = [
  { name: "lq_e0m1", label: "1 · Baseless Base Banter" },
  { name: "lq_e0m2", label: "2 · Cruel Cave Conundrum" },
  { name: "lq_e0m3", label: "3 · Mountainous Mining Menace" },
  { name: "lq_e0m4", label: "4 · Feint-free Funtime" },
  { name: "lq_e0m5", label: "5 · Adequate Aquatic Adventure" },
  { name: "lq_e0m6", label: "6 · Great Greek Grinder" },
  { name: "lq_e0m7", label: "7 · Beyond Baneful Boundaries" },
  { name: "lq_e0m8", label: "Secret · Satan's Smelly Spawn" },
  { name: "start", label: "Hub · Tainted Tech Threshold" },
  { name: "qev_encounter", label: "Test arena · one-grunt encounter" },
];
export const DEMO_ASSETS = [...DEMO.files, DEMO.notice];
export const DEMO_SETUP_HELP = "Run npm run setup:demo in Qev, then reload this page.";
