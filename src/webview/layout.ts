import type { LayoutNode, LeafNode, SplitDir, SplitNode } from '../protocol';

// Operaciones puras sobre el árbol de splits de una pestaña.

export function newId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : undefined;
  return (uuid ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 12);
}

export function leaf(termId: string, name?: string): LeafNode {
  return name ? { kind: 'leaf', id: termId, termId, name } : { kind: 'leaf', id: termId, termId };
}

export function leaves(node: LayoutNode, out: LeafNode[] = []): LeafNode[] {
  if (node.kind === 'leaf') {
    out.push(node);
  } else {
    for (const child of node.children) leaves(child, out);
  }
  return out;
}

interface ParentRef {
  parent: SplitNode;
  index: number;
}

export function findParent(root: LayoutNode, nodeId: string): ParentRef | undefined {
  if (root.kind !== 'split') return undefined;
  const index = root.children.findIndex(c => c.id === nodeId);
  if (index >= 0) return { parent: root, index };
  for (const child of root.children) {
    const found = findParent(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

export function findLeaf(root: LayoutNode, termId: string): LeafNode | undefined {
  return leaves(root).find(l => l.termId === termId);
}

/**
 * Intercambia la posición de dos hojas en el árbol (conservan tamaños de su
 * nueva posición). El nombre manual viaja con la terminal, no con el hueco.
 */
export function swapLeaves(root: LayoutNode, a: string, b: string): void {
  const la = findLeaf(root, a);
  const lb = findLeaf(root, b);
  if (!la || !lb || la === lb) return;
  const nameA = la.name;
  const nameB = lb.name;
  la.termId = b;
  la.id = b;
  lb.termId = a;
  lb.id = a;
  setName(la, nameB);
  setName(lb, nameA);
}

function setName(node: LeafNode, name: string | undefined): void {
  if (name) node.name = name;
  else delete node.name;
}

/**
 * Divide la hoja `termId` en la dirección indicada insertando `added` a su
 * lado (después, o antes si `before`). Si el padre ya va en esa dirección se
 * inserta como hermano; si no, se crea un split anidado. Devuelve la nueva raíz.
 */
export function splitLeaf(
  root: LayoutNode,
  termId: string,
  dir: SplitDir,
  added: LayoutNode,
  before = false,
): LayoutNode {
  const ref = findParent(root, termId);
  if (ref && ref.parent.dir === dir) {
    const { parent, index } = ref;
    const half = parent.sizes[index] / 2;
    parent.sizes[index] = half;
    const at = before ? index : index + 1;
    parent.children.splice(at, 0, added);
    parent.sizes.splice(at, 0, half);
    return root;
  }
  const target = ref ? ref.parent.children[ref.index] : root;
  const split: SplitNode = {
    kind: 'split',
    id: newId(),
    dir,
    children: before ? [added, target] : [target, added],
    sizes: [0.5, 0.5],
  };
  if (!ref) return split;
  ref.parent.children[ref.index] = split;
  return root;
}

/** Quita la hoja y colapsa splits que queden con un solo hijo. null si el árbol queda vacío. */
export function removeLeaf(root: LayoutNode, termId: string): LayoutNode | null {
  if (root.kind === 'leaf') return root.termId === termId ? null : root;
  const ref = findParent(root, termId);
  if (!ref) return root;

  const { parent, index } = ref;
  parent.children.splice(index, 1);
  parent.sizes.splice(index, 1);
  normalizeSizes(parent);
  if (parent.children.length > 1) return root;

  const only = parent.children[0];
  const grand = findParent(root, parent.id);
  if (!grand) return only;

  grand.parent.children[grand.index] = only;
  if (only.kind === 'split' && only.dir === grand.parent.dir) {
    // Aplanar: un split de la misma dirección dentro de su abuelo.
    const share = grand.parent.sizes[grand.index];
    grand.parent.children.splice(grand.index, 1, ...only.children);
    grand.parent.sizes.splice(grand.index, 1, ...only.sizes.map(s => s * share));
  }
  return root;
}

export function equalize(node: LayoutNode): void {
  if (node.kind !== 'split') return;
  node.sizes = node.children.map(() => 1 / node.children.length);
  node.children.forEach(equalize);
}

/** Valida un árbol cargado del almacenamiento. Devuelve null si no es utilizable. */
export function sanitize(node: unknown): LayoutNode | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Partial<LayoutNode>;
  if (n.kind === 'leaf') {
    const raw = n as Partial<LeafNode>;
    if (typeof raw.termId !== 'string' || !raw.termId) return null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : undefined;
    return leaf(raw.termId, name);
  }
  if (n.kind === 'split') {
    const s = n as Partial<SplitNode>;
    const dir: SplitDir = s.dir === 'col' ? 'col' : 'row';
    const rawChildren = Array.isArray(s.children) ? s.children : [];
    const rawSizes = Array.isArray(s.sizes) ? s.sizes : [];
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    rawChildren.forEach((child, i) => {
      const clean = sanitize(child);
      if (!clean) return;
      children.push(clean);
      const size = Number(rawSizes[i]);
      sizes.push(Number.isFinite(size) && size > 0 ? size : 1);
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    const split: SplitNode = { kind: 'split', id: typeof s.id === 'string' ? s.id : newId(), dir, children, sizes };
    normalizeSizes(split);
    return split;
  }
  return null;
}

function normalizeSizes(split: SplitNode): void {
  const total = split.sizes.reduce((a, b) => a + b, 0) || 1;
  split.sizes = split.sizes.map(s => s / total);
}
