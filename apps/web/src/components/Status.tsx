export type StatusState =
  | { kind: "idle" }
  | { kind: "busy"; text: string }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export function Status({ state }: { state: StatusState }) {
  if (state.kind === "idle") return null;
  return (
    <div className={`status status--${state.kind}`} role={state.kind === "error" ? "alert" : "status"}>
      {state.kind === "busy" && <span className="spinner" aria-hidden="true" />}
      {state.text}
    </div>
  );
}
