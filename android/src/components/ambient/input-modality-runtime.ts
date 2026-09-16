export type InputModality = 'keyboard' | 'pointer';

const INPUT_MODALITY_ATTRIBUTE = 'data-zterm-input-modality';
let installed = false;

export function createInputModalityRuntime(root: HTMLElement, target: EventTarget) {
  const setModality = (modality: InputModality) => {
    root.setAttribute(INPUT_MODALITY_ATTRIBUTE, modality);
  };
  const handlePointerDown = () => setModality('pointer');
  const handleKeyDown = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Tab') {
      setModality('keyboard');
    }
  };

  setModality('pointer');
  target.addEventListener('pointerdown', handlePointerDown, true);
  target.addEventListener('keydown', handleKeyDown, true);

  return () => {
    target.removeEventListener('pointerdown', handlePointerDown, true);
    target.removeEventListener('keydown', handleKeyDown, true);
  };
}

export function installInputModalityRuntime() {
  if (installed || typeof document === 'undefined') {
    return;
  }
  createInputModalityRuntime(document.documentElement, document);
  installed = true;
}
