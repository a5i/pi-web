"use client";

/**
 * The STL preview's lazy renderer chunk — React Three Fiber + three.
 *
 * Everything three.js lives here, behind React.lazy in components/CadPreview.tsx
 * (the LikeC4DiagramChunk / OpenApiPreviewChunk pattern): no other FileViewer
 * path should pay for a ~1MB renderer, and a browser that cannot parse the
 * chunk (old iOS Safari) hits the boundary's message instead of blanking the
 * pane. The parsed arrays arrive from lib/cad-stl.ts and are used in place —
 * the Float32Arrays go straight into the BufferGeometry, nothing copies.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { StlBounds, StlMesh } from "@/lib/cad-stl";

function themeColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

interface Fit {
  center: [number, number, number];
  distance: number;
  gridSize: number;
}

function fitView(bounds: StlBounds): Fit {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const size = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    1e-6,
  );
  return { center, distance: size * 1.9, gridSize: size * 4 };
}

function StlModel({ mesh, color }: { mesh: StlMesh; color: string }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    g.computeBoundingSphere();
    return g;
  }, [mesh]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry}>
      {/* STL winding is unreliable in the wild; DoubleSide keeps holes out. */}
      <meshStandardMaterial color={color} side={THREE.DoubleSide} roughness={0.55} metalness={0.1} />
    </mesh>
  );
}

function Lights({ fit }: { fit: Fit }) {
  const [cx, cy, cz] = fit.center;
  const d = fit.distance;
  return (
    <>
      <hemisphereLight intensity={0.9} groundColor="#3a3f46" />
      {/* Lights ride with the model: a part far from the origin is still lit from above. */}
      <directionalLight position={[cx + d, cy + 2 * d, cz + d]} intensity={1.6} />
      <directionalLight position={[cx - d, cy + d, cz - d]} intensity={0.5} />
    </>
  );
}

/** Orbit controls plus a camera fitted to the model; re-fits when a reload moves it. */
function Rig({ fit }: { fit: Fit }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = false;
    controlsRef.current = controls;
    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const [cx, cy, cz] = fit.center;
    controls.target.set(cx, cy, cz);
    camera.position.set(cx + fit.distance, cy + fit.distance * 0.65, cz + fit.distance);
    camera.near = Math.max(fit.distance / 1000, 0.001);
    camera.far = fit.distance * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }, [camera, fit]);

  return null;
}

export interface CadPreviewPaneProps {
  mesh: StlMesh;
}

export function CadPreviewPane({ mesh }: CadPreviewPaneProps) {
  const fit = useMemo(() => fitView(mesh.bounds), [mesh.bounds]);
  const accent = useMemo(() => themeColor("--accent", "#5b8bd0"), []);
  const gridColor = useMemo(() => themeColor("--border", "#444444"), []);

  return (
    <div className="cad-preview-canvas">
      {/* No Canvas `fallback`: R3F renders it as <canvas> children (always in
          the DOM, hidden) and rethrows a failed WebGL context to the boundary
          above, which already shows the right message. */}
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <Lights fit={fit} />
        <StlModel mesh={mesh} color={accent} />
        <gridHelper
          args={[fit.gridSize, 20, gridColor, gridColor]}
          position={[fit.center[0], mesh.bounds.min[1], fit.center[2]]}
        />
        <Rig fit={fit} />
      </Canvas>
    </div>
  );
}
