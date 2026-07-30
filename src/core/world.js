import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const _raycaster = new THREE.Raycaster();
_raycaster.firstHitOnly = true;
const _hitNormal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();

export class CollisionWorld {
  constructor() {
    this.colliders = [];
  }

  addCollider(mesh, { surface = 'asphalt', dynamic = false } = {}) {
    if (!mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree();
    mesh.userData.surface = surface;
    mesh.userData.dynamic = dynamic;
    if (!this.colliders.includes(mesh)) this.colliders.push(mesh);
  }

  removeCollider(mesh) {
    const i = this.colliders.indexOf(mesh);
    if (i !== -1) this.colliders.splice(i, 1);
  }

  /** World-space raycast against all colliders. dir must be normalized. */
  raycast(origin, dir, far) {
    _raycaster.ray.origin.copy(origin);
    _raycaster.ray.direction.copy(dir);
    _raycaster.near = 0;
    _raycaster.far = far;
    let best = null;
    for (let i = 0; i < this.colliders.length; i++) {
      const mesh = this.colliders[i];
      const hits = _raycaster.intersectObject(mesh, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        best = hits[0];
        best.mesh = mesh;
      }
    }
    if (!best) return null;
    _normalMatrix.getNormalMatrix(best.mesh.matrixWorld);
    _hitNormal.copy(best.face.normal).applyMatrix3(_normalMatrix).normalize();
    return {
      point: best.point,
      normal: _hitNormal,
      distance: best.distance,
      surface: best.mesh.userData.surface,
      mesh: best.mesh,
    };
  }
}
