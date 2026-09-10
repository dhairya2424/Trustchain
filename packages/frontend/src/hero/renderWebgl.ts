import { computeLinks, createNodes, stepNodes, FIELD_PRESETS } from "./field";
import type { FieldHandle } from "./renderCanvas2d";

/**
 * The full particle network.
 *
 * three.js is imported dynamically, and only from here. It is by far the heaviest thing the
 * app depends on, and the majority of visits — anyone on a phone, anyone with reduced
 * motion on, anyone without WebGL — never render this at all. A static import would put it
 * in the entry chunk and make all of those people download it to not use it.
 *
 * The scene is two objects: a Points cloud for the nodes and a single LineSegments for
 * every link. Links are one object with a rewritten position buffer each frame rather than
 * a line per pair, because a few hundred draw calls per frame is what actually costs the
 * frame budget here, not the vertex count.
 */
export async function startWebgl(canvas: HTMLCanvasElement): Promise<FieldHandle> {
  const THREE = await import("three");

  const preset = FIELD_PRESETS.webgl;
  const nodes = createNodes(preset);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 2.6;

  const nodePositions = new Float32Array(nodes.length * 3);
  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute("position", new THREE.BufferAttribute(nodePositions, 3));

  const nodeMaterial = new THREE.PointsMaterial({
    // Neutral, and normal blending rather than additive.
    //
    // Additive blending is what produces the "glowing" particle look: overlapping points
    // sum toward white and bloom. That reads as a screensaver. The field here is meant to
    // read as a lattice under observation, so points stay a flat grey and simply overlap.
    color: 0x8a8a93,
    size: 0.016,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(nodeGeometry, nodeMaterial);
  scene.add(points);

  const maxLinks = 1400;
  const linkPositions = new Float32Array(maxLinks * 6);
  const linkColors = new Float32Array(maxLinks * 6);
  const linkGeometry = new THREE.BufferGeometry();
  linkGeometry.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3));
  linkGeometry.setAttribute("color", new THREE.BufferAttribute(linkColors, 3));

  const linkMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(linkGeometry, linkMaterial);
  scene.add(lines);

  let width = 1;
  let height = 1;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(rect.width, 1);
    height = Math.max(rect.height, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  resize();

  /*
   * Measure again whenever the box actually changes, not only on window resize.
   *
   * The first `resize()` above can run before the stylesheet has been applied — this module
   * arrives through a dynamic import, and in development the CSS is injected by script, so
   * the two race. Unstyled, the canvas is an ordinary block whose `height: 100%` resolves
   * against the page-tall wrapper rather than the viewport, and it measures the height of
   * the entire document: 2588px against an 856px viewport, measured.
   *
   * The scene was then rendered into a buffer three times too tall and squashed into a short
   * element, which is what made the lattice look stretched and broken. It corrected itself
   * the moment anything resized the window, which is exactly the shape of a race.
   *
   * A ResizeObserver fires when the element's box settles, so the buffer matches whatever the
   * element really is — on first paint, on window resize, and on any later layout change.
   */
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => resize());
  observer?.observe(canvas);

  let frame = 0;
  let last = 0;
  let running = true;

  const draw = (timestamp: number) => {
    if (!running) return;

    const delta = last === 0 ? 0 : (timestamp - last) / 1000;
    last = timestamp;

    stepNodes(nodes, delta);

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) continue;
      nodePositions[i * 3] = node.x;
      nodePositions[i * 3 + 1] = node.y;
      nodePositions[i * 3 + 2] = node.z;
    }
    nodeGeometry.attributes.position!.needsUpdate = true;

    const links = computeLinks(nodes, preset.linkDistance, maxLinks);

    for (let i = 0; i < links.length; i += 1) {
      const link = links[i]!;
      const a = nodes[link.a];
      const b = nodes[link.b];
      if (!a || !b) continue;

      const p = i * 6;
      linkPositions[p] = a.x;
      linkPositions[p + 1] = a.y;
      linkPositions[p + 2] = a.z;
      linkPositions[p + 3] = b.x;
      linkPositions[p + 4] = b.y;
      linkPositions[p + 5] = b.z;

      // Neutral grey, scaled by how close the pair is, so the mesh fades in and out at its
      // edges instead of links popping into existence at full brightness. Monochrome by
      // design: colour in this product means status, and a decorative field has none.
      const s = link.strength;
      const r = 0.5 * s;
      const g = 0.5 * s;
      const bl = 0.55 * s;
      linkColors[p] = r;
      linkColors[p + 1] = g;
      linkColors[p + 2] = bl;
      linkColors[p + 3] = r;
      linkColors[p + 4] = g;
      linkColors[p + 5] = bl;
    }

    // Only the filled portion of the buffer is drawn; the tail is stale but never
    // referenced, which is cheaper than clearing it every frame.
    linkGeometry.setDrawRange(0, links.length * 2);
    linkGeometry.attributes.position!.needsUpdate = true;
    linkGeometry.attributes.color!.needsUpdate = true;

    // A slow yaw. The field is symmetric, so this reads as the structure turning rather
    // than the camera moving, which is the intended "system under observation" feel.
    points.rotation.y += delta * 0.045;
    lines.rotation.y = points.rotation.y;

    renderer.render(scene, camera);
    frame = requestAnimationFrame(draw);
  };

  frame = requestAnimationFrame(draw);

  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      last = 0;
      frame = requestAnimationFrame(draw);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("resize", resize);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("resize", resize);
      observer?.disconnect();

      // GPU memory is not garbage collected with the JS objects that reference it. Without
      // these the context leaks a buffer set per mount, and browsers cap live contexts —
      // so a few navigations back to the landing page would kill the renderer outright.
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      renderer.dispose();
    },
  };
}
