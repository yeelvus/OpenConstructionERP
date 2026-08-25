// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Issue 426 - the viewer rendered a drawing that did not match the source.
 *
 * Two defects, and this file exists because one of them shipped twice.
 *
 * B, the text clamp. `f936eace4` ("draw text at the scale the drawing asks
 * for") removed a readable band from `textFontSize`. `14aef60d5` ("place a
 * block's geometry where the drawing puts it") put it back five hours later,
 * along with a docstring arguing that the band was intended. Both commits are
 * contained in tag v14.4.0, so the release advertised the fix and shipped
 * without it, and nobody reading HEAD could tell - the file read as if the
 * clamp had always been the plan. Nothing in the suite could tell either,
 * because every fixture in it was small enough that the band never bound.
 *
 * A, the scene. The entity set handed to `computeExtents` used to be the union
 * of every sheet until an effect latched a chosen one, so the first painted
 * frame of every drawing fitted model space and paper space into one box.
 *
 * The measurements below run through the real `computeExtents` / `zoomToFit`
 * over converted bench drawings, so a fit scale here is the fit scale the
 * viewer computes, not an estimate of one.
 */
import { describe, it, expect } from 'vitest';

import { computeExtents, zoomToFit } from '../viewport';
import { effectiveLayout, layoutNames, sceneEntities, textFontSize } from '../dxf-renderer';
import type { DxfEntity } from '../../api';
import type { BenchDrawing } from './fixtures/bench-drawings';
import { MODEL_AND_PAPERSPACE, TEXT_HEIGHTS } from './fixtures/bench-drawings';

/** The canvas the viewer gets in an ordinary desktop window. */
const CANVAS_W = 1200;
const CANVAS_H = 800;

/** The scene the viewer paints on the frame after a drawing loads: nothing
 *  picked yet, which is where defect A lived. */
function firstPaintScene(d: BenchDrawing): DxfEntity[] {
  return sceneEntities(d.entities, layoutNames(d.entities), null);
}

function fitFor(entities: DxfEntity[]) {
  return zoomToFit(computeExtents(entities), CANVAS_W, CANVAS_H);
}

function textsOf(entities: DxfEntity[]): DxfEntity[] {
  return entities.filter((e) => e.type === 'TEXT');
}

function byHeight(entities: DxfEntity[], h: number): DxfEntity {
  const found = textsOf(entities).find((e) => e.height === h);
  if (!found) throw new Error(`fixture has no text authored at height ${h}`);
  return found;
}

describe('B - the authored text height survives to the screen', () => {
  const scene = firstPaintScene(TEXT_HEIGHTS);
  // 6000 x 4000 mm of geometry in a 1200 x 800 canvas: 0.192 px per mm.
  const vp = fitFor(scene);

  it('draws a label at the size the drawing asks for', () => {
    const tag = byHeight(scene, 25); // a room tag
    expect(textFontSize(tag, vp)).toBeCloseTo(25 * vp.scale, 6); // 4.8 px, not 8
  });

  it('does not shrink a title that is genuinely large', () => {
    // The band was never only a floor. A 20 m sheet title was cut to 72 px,
    // so small text came out too big and large text too small at once, and
    // the sheet was compressed toward one uniform size.
    const title = byHeight(scene, 20000);
    expect(textFontSize(title, vp)).toBeCloseTo(20000 * vp.scale, 6); // 3840 px
  });

  it('keeps the ratio between two authored heights', () => {
    // The property the band destroyed, and the one worth pinning: a heading
    // authored 8x the height of a room tag has to reach the screen 8x its
    // size, whatever the zoom.
    const tag = byHeight(scene, 25);
    const heading = byHeight(scene, 200);
    const authoredRatio = heading.height! / tag.height!;
    expect(authoredRatio).toBe(8);
    expect(textFontSize(heading, vp) / textFontSize(tag, vp)).toBeCloseTo(authoredRatio, 6);
  });

  it('keeps that ratio at every zoom', () => {
    const tag = byHeight(scene, 25);
    const heading = byHeight(scene, 200);
    for (const scale of [0.002, 0.192, 1, 40]) {
      const zoomed = { offsetX: 0, offsetY: 0, scale };
      expect(textFontSize(heading, zoomed) / textFontSize(tag, zoomed)).toBeCloseTo(8, 6);
    }
  });

  it('carries the drawing’s whole authored range to the screen', () => {
    // 800:1 authored. Under the band it reached the screen as 9:1, which is
    // why a room tag and a sheet title came out nearly the same size and the
    // drawing stopped reading as a drawing.
    const heights = textsOf(scene).map((e) => e.height ?? 2.5);
    const drawn = textsOf(scene).map((e) => textFontSize(e, vp));
    const authoredRange = Math.max(...heights) / Math.min(...heights);
    const drawnRange = Math.max(...drawn) / Math.min(...drawn);
    expect(authoredRange).toBe(800);
    expect(drawnRange).toBeCloseTo(authoredRange, 6);
  });

  it('multiplies the authored height by the reader’s size preference', () => {
    // The size control has to sit on the authored height, not on a banded
    // result. Applied to a banded result it can only move every label
    // together, so a sheet whose proportions have already been flattened
    // stays flattened at every setting.
    const tag = byHeight(scene, 25);
    const heading = byHeight(scene, 200);
    for (const preference of [0.5, 1, 2.5]) {
      expect(textFontSize(tag, vp, preference)).toBeCloseTo(25 * preference * vp.scale, 6);
      expect(textFontSize(heading, vp, preference) / textFontSize(tag, vp, preference)).toBeCloseTo(
        8,
        6,
      );
    }
  });
});

describe('A - one scene is one sheet', () => {
  const layouts = layoutNames(MODEL_AND_PAPERSPACE.entities);

  it('reads both sheets out of the drawing', () => {
    expect(layouts).toEqual(['Model', 'Layout1']);
  });

  it('shows a sheet on the first frame, before anything is picked', () => {
    expect(effectiveLayout(layouts, null)).toBe('Model');
  });

  it('paints exactly one sheet when nothing is picked', () => {
    const scene = firstPaintScene(MODEL_AND_PAPERSPACE);
    expect(new Set(scene.map((e) => e.layout))).toEqual(new Set(['Model']));
  });

  it('frames the first paint the same way as picking that sheet by hand', () => {
    // The bug in one assertion: these two used to differ, so the drawing
    // jumped the first time the reader touched the sheet strip.
    const firstPaint = fitFor(firstPaintScene(MODEL_AND_PAPERSPACE));
    const picked = fitFor(
      sceneEntities(MODEL_AND_PAPERSPACE.entities, layouts, 'Model'),
    );
    expect(firstPaint.scale).toBeCloseTo(picked.scale, 10);
    expect(firstPaint.offsetX).toBeCloseTo(picked.offsetX, 10);
    expect(firstPaint.offsetY).toBeCloseTo(picked.offsetY, 10);
  });

  it('ignores a pick left over from a drawing that had that sheet', () => {
    // Switching files must not leave the viewer filtering by a name the new
    // file never had, which paints an empty canvas.
    expect(effectiveLayout(layouts, 'Sheet-A-101')).toBe('Model');
    const scene = sceneEntities(MODEL_AND_PAPERSPACE.entities, layouts, 'Sheet-A-101');
    expect(scene.length).toBeGreaterThan(0);
  });

  it('keeps the union for a drawing whose entities carry no sheet at all', () => {
    // One implied sheet, everything on it. This is the only case where the
    // union is the right answer, and it has to keep working.
    const loose = MODEL_AND_PAPERSPACE.entities.map((e) => ({ ...e, layout: undefined }));
    expect(layoutNames(loose)).toEqual([]);
    expect(sceneEntities(loose, [], null)).toHaveLength(loose.length);
  });

  it('never offers a block definition as a sheet', () => {
    // The other half of the backend's contract. A definition arrives tagged
    // `block` and carrying no layout, so it can only reach the picker if
    // something starts reading a name off the tag. A real export carries
    // ~1700 definitions against one sheet, so a regression here is a strip of
    // seventeen hundred thumbnails rather than a hidden one.
    const definitionMember = (block: string): DxfEntity => ({
      id: `def-${block}`,
      type: 'LINE',
      layer: '0',
      color: 7,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      block,
    });
    const withDefs = MODEL_AND_PAPERSPACE.entities.concat([
      definitionMember('DOOR-900'),
      definitionMember('*D1000'),
    ]);
    expect(layoutNames(withDefs)).toEqual(layouts);
    expect(sceneEntities(withDefs, layouts, 'Model').every((e) => !e.block)).toBe(true);
  });

  it('never hands the renderer two coordinate systems in one box', () => {
    // Why the union is not a fallback. Model space is an 18 m building and
    // Layout1 is a 400 mm paper sheet; fitted together the sheet collapses to
    // a speck drawn over the plan. The two fits are two orders of magnitude
    // apart, and the union agrees with neither.
    const union = MODEL_AND_PAPERSPACE.entities.filter((e) => !e.block);
    const unionFit = fitFor(union);
    const modelFit = fitFor(sceneEntities(MODEL_AND_PAPERSPACE.entities, layouts, 'Model'));
    const sheetFit = fitFor(sceneEntities(MODEL_AND_PAPERSPACE.entities, layouts, 'Layout1'));
    expect(sheetFit.scale / unionFit.scale).toBeGreaterThan(40);
    expect(firstPaintScene(MODEL_AND_PAPERSPACE).length).toBeLessThan(union.length);
    expect(fitFor(firstPaintScene(MODEL_AND_PAPERSPACE)).scale).toBeCloseTo(modelFit.scale, 10);
  });
});

describe('A and B are one bug: the scene decides the label size', () => {
  it('gives a label the same size in drawing units whichever scene is fitted', () => {
    // `textFontSize` is a function of the viewport, and the viewport is a
    // function of the scene. With the band in place a scale difference became
    // a size difference relative to the geometry: the same 8 mm title-block
    // label occupied 8 mm of the sheet under its own viewport and 123 mm under
    // the union one. That is the reporter's sentence - a render close to the
    // original, but the labels are much bigger.
    const layouts = layoutNames(MODEL_AND_PAPERSPACE.entities);
    const union = MODEL_AND_PAPERSPACE.entities.filter((e) => !e.block);
    const unionVp = fitFor(union);
    const sheetVp = fitFor(sceneEntities(MODEL_AND_PAPERSPACE.entities, layouts, 'Layout1'));

    const label = byHeight(union.filter((e) => e.layout === 'Layout1'), 8);
    const underUnion = textFontSize(label, unionVp) / unionVp.scale;
    const underSheet = textFontSize(label, sheetVp) / sheetVp.scale;

    // A label's size in drawing units is a property of the drawing. It cannot
    // depend on which scene happened to be fitted.
    expect(underUnion).toBeCloseTo(underSheet, 6);
    expect(underSheet).toBeCloseTo(8, 6);
  });
});
