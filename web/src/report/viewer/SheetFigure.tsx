// A report's sheet, live: the app's own canvas in read mode, the saved
// scene the report was made from, the report's own pictures. A reader pans,
// zooms, clicks a claim and sees what it rests on, as a member would; they
// cannot move or change anything (`CanvasProps.readOnly`).
import { type ReportData, fileId } from '@digsite/shared';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { Icon } from '../../components/Icon.tsx';
import { Canvas } from '../../sheet/canvas/Canvas.tsx';
import type {
  CanvasFile,
  CanvasHandle,
  SceneChange,
} from '../../sheet/canvas/types.ts';

export interface SheetFigureHandle {
  /** Selects a claim and frames it with what it rests on. */
  show(elementId: string): void;
}

interface Props {
  data: ReportData;
  pictures: Readonly<Record<string, string>>;
  /** The selection changed on the canvas. */
  onSelect: (elementIds: string[]) => void;
}

export const SheetFigure = forwardRef<SheetFigureHandle, Props>(
  function SheetFigure({ data, pictures, onSelect }, ref) {
    const canvasRef = useRef<CanvasHandle | null>(null);
    const files = useMemo(() => {
      const out = new Map<string, CanvasFile>();
      for (const [imageId, src] of Object.entries(pictures))
        out.set(fileId(imageId), {
          id: fileId(imageId),
          dataURL: src,
          mimeType: 'image/jpeg',
        });
      return out;
    }, [pictures]);
    const captions = useMemo(
      () => new Map(data.images.map((img) => [img.id, img.name])),
      [data],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !data.scene) return;
      canvas.applyRemote(data.scene.elements);
      // Once the container has its size.
      const frame = requestAnimationFrame(() => canvas.zoomToFit());
      return () => cancelAnimationFrame(frame);
    }, [data]);

    const show = useCallback((elementId: string) => {
      const canvas = canvasRef.current;
      const el = canvas?.elements().find((e) => e.id === elementId);
      if (!canvas || !el) return;
      canvas.zoomToFit(
        [el.id, el.startBinding?.elementId, el.endBinding?.elementId].filter(
          (id): id is string => !!id,
        ),
      );
      canvas.select([el.id]);
    }, []);
    useImperativeHandle(ref, () => ({ show }), [show]);

    const lastSelection = useRef('');
    const onChange = useCallback(
      (scene: SceneChange) => {
        const key = scene.selectedIds.join(',');
        if (key === lastSelection.current) return;
        lastSelection.current = key;
        onSelect(scene.selectedIds);
      },
      [onSelect],
    );

    return (
      <div className="rv-sheet">
        <div className="rv-canvas">
          <Canvas
            ref={canvasRef}
            files={files}
            tool="select"
            readOnly
            captions={captions}
            onChange={onChange}
          />
        </div>
        <div className="rv-tools" role="toolbar" aria-label="The sheet">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => canvasRef.current?.zoomBy(1 / 1.25)}
          >
            <Icon name="minus" size={16} />
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => canvasRef.current?.zoomBy(1.25)}
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            type="button"
            aria-label="Fit every picture"
            onClick={() => canvasRef.current?.zoomToFit()}
          >
            <Icon name="fit" size={16} />
          </button>
        </div>
      </div>
    );
  },
);
