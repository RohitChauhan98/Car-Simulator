import type { VehicleId, VehicleSpec } from '../config';
import { VEHICLES } from '../config';

export function bindGarage(
  overlay: HTMLElement,
  onSelect: (spec: VehicleSpec) => void | Promise<void>,
): { setSelected: (id: VehicleId) => void; setBusy: (busy: boolean) => void } {
  const cards = [...overlay.querySelectorAll<HTMLButtonElement>('[data-vehicle]')];

  const setSelected = (id: VehicleId) => {
    for (const card of cards) {
      const on = card.dataset.vehicle === id;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  };

  const setBusy = (busy: boolean) => {
    for (const card of cards) card.disabled = busy;
  };

  for (const card of cards) {
    card.addEventListener('click', async () => {
      const spec = VEHICLES.find((v) => v.id === card.dataset.vehicle);
      if (!spec) return;
      setSelected(spec.id);
      setBusy(true);
      try {
        await onSelect(spec);
      } finally {
        setBusy(false);
      }
    });
  }

  return { setSelected, setBusy };
}
