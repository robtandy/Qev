// Deterministic protocol-shaped test replies; never used by the running app.
export function replies(requests, selectedIndex = null) {
  return requests.map((request, index) => {
    const keys = Object.keys(request.questions.action?.criteria || {});
    const selected = selectedIndex ?? keys.length - 1;
    const answer = keys.length ? {
      action: { type: "choice", choice: keys[selected], probabilities: Object.fromEntries(keys.map((key, i) =>
        [key, keys.length === 1 ? 1 : i === selected ? 0.9 : 0.1 / (keys.length - 1)])) },
    } : { favorable: { type: "noul", noul: selectedIndex === null ? 0.5 + index / 100 : index === selectedIndex ? 0.9 : 0.1 } };
    return { model: "mock", answers: answer,
      raw_probabilities: { [keys.length ? "action" : "favorable"]: [0.123456789, 0.876543211] },
      timing: { tokens: 123 }, extra: "unmodified response" };
  });
}
