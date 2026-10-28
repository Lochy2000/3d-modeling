import * as THREE from 'three';
import type { BuiltRoom } from './types';

type Face = { mesh: THREE.Mesh; triangle: number; points: THREE.Vector3[]; normal: THREE.Vector3; plane: number; bounds: THREE.Box3; front: boolean };
export type WallOverlap = { first: string; second: string; area: number };
const EPSILON = 1e-5; // 0.01 mm: numerical coincidence, not intentional layered surfaces.
const side = (a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2) => (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);

function overlapArea(a: Face, b: Face) {
  if (!a.bounds.intersectsBox(b.bounds) || a.normal.dot(b.normal) < .999999
    || b.points.some(p => Math.abs(a.normal.dot(p)-a.plane)>EPSILON)) return 0;
  const n=a.normal, axis=Math.abs(n.x)>Math.abs(n.y)?(Math.abs(n.x)>Math.abs(n.z)?0:2):(Math.abs(n.y)>Math.abs(n.z)?1:2);
  const axes=[0,1,2].filter(k=>k!==axis);
  const project=(p:THREE.Vector3)=>new THREE.Vector2(p.getComponent(axes[0]),p.getComponent(axes[1]));
  let polygon=a.points.map(project);
  const clip=b.points.map(project);if(side(clip[0],clip[1],clip[2])<0)clip.reverse();
  for(let j=0;j<3;j++){
    const output:THREE.Vector2[]=[],c=clip[j],d=clip[(j+1)%3];
    for(let k=0;k<polygon.length;k++){
      const p=polygon[k],q=polygon[(k+1)%polygon.length],dp=side(c,d,p),dq=side(c,d,q);
      if(dp>=0)output.push(p);
      if((dp<0&&dq>0)||(dp>0&&dq<0))output.push(p.clone().lerp(q,dp/(dp-dq)));
    }
    polygon=output;
  }
  let area=0;for(let i=0;i<polygon.length;i++){const p=polygon[i],q=polygon[(i+1)%polygon.length];area+=p.x*q.y-p.y*q.x;}
  return Math.abs(area/2/n.getComponent(axis));
}

/** Audit actual slab triangles, then resolve only coincident faces with a stable depth bias.
 * Keep both surfaces: either wall may disappear independently in the dollhouse cutaway.
 * Interior paint wins over an adjoining slab's end cap. No object geometry is simplified,
 * and the original shared materials are never mutated.
 */
export function stabilizeWallOverlaps(walls: BuiltRoom['walls']): WallOverlap[] {
  const faces:Face[]=[],meshes:THREE.Mesh[]=[],names=new Map<THREE.Mesh,string>();
  for(const wall of walls)wall.group.traverse(o=>{
    if(!(o instanceof THREE.Mesh)||o.name!=='slab')return;
    meshes.push(o);names.set(o,`${o.userData.houseRoom??'room'}/${wall.def.name}`);
    o.updateWorldMatrix(true,false);
    const g=o.geometry,p=g.getAttribute('position'),count=g.index?.count??p.count;
    for(let i=0;i<count;i+=3){
      const points=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(p,g.index?g.index.getX(i+k):i+k).applyMatrix4(o.matrixWorld));
      const normal=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
      if(normal.lengthSq()<1e-16)continue;normal.normalize();
      faces.push({mesh:o,triangle:i/3,points,normal,plane:normal.dot(points[0]),bounds:new THREE.Box3().setFromPoints(points).expandByScalar(EPSILON),front:normal.dot(wall.def.n)>.999});
    }
  });
  const affected=new Map<THREE.Mesh,Map<number,boolean>>(),reports=new Map<string,WallOverlap>();
  const mark=(f:Face)=>{let triangles=affected.get(f.mesh);if(!triangles)affected.set(f.mesh,triangles=new Map());triangles.set(f.triangle,f.front);};
  for(let i=0;i<faces.length;i++)for(let j=i+1;j<faces.length;j++){
    const a=faces[i],b=faces[j];if(a.mesh===b.mesh)continue;
    const area=overlapArea(a,b);if(area<1e-6)continue;
    mark(a);mark(b);
    const key=`${a.mesh.id}:${b.mesh.id}`,report=reports.get(key)??{first:names.get(a.mesh)!,second:names.get(b.mesh)!,area:0};
    report.area+=area;reports.set(key,report);
  }
  for(const [mesh,triangles] of affected){
    const geometry=mesh.geometry.clone(),original=Array.isArray(mesh.material)?mesh.material:[mesh.material],materials=[...original];
    const variants=new Map<string,number>(),groups=geometry.groups.map(g=>({...g}));geometry.clearGroups();
    const count=geometry.index?.count??geometry.getAttribute('position').count;
    for(let i=0;i<count;i+=3){
      let material=groups.find(g=>i>=g.start&&i<g.start+g.count)?.materialIndex??0;
      if(triangles.has(i/3)){
        const priority=meshes.indexOf(mesh)+1+(triangles.get(i/3)?meshes.length:0),key=`${material}:${priority}`;
        let variant=variants.get(key);
        if(variant===undefined){
          const biased=original[material].clone();biased.polygonOffset=true;biased.polygonOffsetFactor=0;biased.polygonOffsetUnits=-priority;
          variant=materials.length;materials.push(biased);variants.set(key,variant);
        }
        material=variant;
      }
      const last=geometry.groups.at(-1);
      if(last?.materialIndex===material)last.count+=3;else geometry.addGroup(i,3,material);
    }
    mesh.geometry=geometry;mesh.material=materials;
  }
  return [...reports.values()].sort((a,b)=>b.area-a.area);
}
