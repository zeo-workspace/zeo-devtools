// Not imported by main.tsx: the plugin test transforms it directly to prove the default
// `exclude` list (react-three-fiber intrinsics) is applied without any option.
export function Scene() {
  return (
    <div id="scene-root">
      {/* @ts-expect-error `mesh` is a react-three-fiber intrinsic, unknown to react-dom */}
      <mesh position={[0, 0, 0]} />
    </div>
  );
}
