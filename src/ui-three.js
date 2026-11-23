/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * What the Topics page draws its map with (ui/topicview.js): the parts of three.js it uses, and
 * its orbit controls.
 *
 * The page does not load this file: scripts/ui-markdown.mjs bundles it into
 * src/ui-three.bundle.js, which the Worker serves at /inbox/three.js, and the page imports that
 * when it first draws the map.
 */

export {
  Box3, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group, HemisphereLight,
  LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene,
  ShaderMaterial, Sphere, SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
