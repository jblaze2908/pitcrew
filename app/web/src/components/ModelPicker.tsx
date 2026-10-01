// Provider and model for a member. Models load on first focus (one /api/models call), and again if the provider changes.
import { useId, useState } from "react";
import type { ModelInfo, ProviderId } from "../../../shared/types";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Field } from "./ui";

export function ModelPicker({ provider, model, onProvider, onModel }: { provider: string; model: string; onProvider: (p: ProviderId) => void; onModel: (m: string) => void }) {
  const { S } = useStore();
  const listId = useId();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const load = async (p: string, m: string) => {
    const list = await api.get<ModelInfo[]>(`/api/models?provider=${p}&q=${encodeURIComponent(m.split("/")[0] || "")}`, { quiet: true }).catch(() => []);
    setModels(list);
  };
  return (
    <div className="grid2">
      <Field label="Provider">
        <select value={provider} onChange={(e) => { const p = e.target.value as ProviderId; onProvider(p); onModel(""); load(p, ""); }}>
          {Object.entries(S.providers).map(([k, p]) => <option key={k} value={k}>{`${p.label}${p.connected ? "" : " (not connected)"}`}</option>)}
        </select>
      </Field>
      <Field label="Model">
        <div>
          <input value={model} list={listId} placeholder="model id" onChange={(e) => onModel(e.target.value)} onFocus={() => { if (!models) load(provider, model); }} />
          <datalist id={listId}>{(models || []).map((m) => (
            <option key={m.id} value={m.id}>{m.price ? `${m.name} · $${(m.price.in * 1e6).toFixed(2)}/$${(m.price.out * 1e6).toFixed(2)} per M` : m.name}</option>))}
          </datalist>
        </div>
      </Field>
    </div>
  );
}
