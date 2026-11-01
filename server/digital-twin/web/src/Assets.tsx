import { t } from "i18next";
import { useEffect, useState } from "react";
import { api, type AssetInfo } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { formatBytes, formatDateTime } from "./i18n.ts";
import { ErrorNotice } from "./ui.tsx";

/** An asset's name from a file's: lower case, the characters a name may have, at most 64. */
const nameOf = (file: string) =>
  file
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);

/**
 * The twin's 3D assets (its administration's "3D models" tab): binary glTF files (.glb) a model's drawing places by
 * name (`"shape": "gltf", "asset": "<name>"`). Admins upload, replace and delete them; the server refuses a file that
 * isn't a self-contained GLB.
 */
export function Assets() {
  const [list, setList] = useState<AssetInfo[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = () => void api.assets().then(setList, (e: Error) => setError(e.message));
  useEffect(load, []);
  const upload = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.putAsset(nameOf(file.name), file);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (name: string) => {
    if (!confirm(t("instances:assets.confirmDelete", { name }))) return;
    try {
      await api.deleteAsset(name);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <ErrorNotice error={error} />
      <section className="max-w-3xl">
        <p className="section-header">{t("instances:assets.title")}</p>
        <p className="mt-1 text-xs text-fg-muted">{t("instances:assets.help")}</p>
        <label className="btn-secondary mt-2 inline-flex cursor-pointer items-center gap-1 px-2 py-1 text-xs" aria-disabled={busy}>
          <Icon name="add" className="h-4 w-4" />
          {t("instances:assets.upload")}
          <input
            type="file"
            accept=".glb,model/gltf-binary"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        {list && !list.length && <p className="mt-3 text-xs text-fg-muted">{t("instances:assets.empty")}</p>}
        {!!list?.length && (
          <table className="mt-3 w-full text-xs">
            <thead className="text-start text-fg-muted">
              <tr>
                <th className="py-1 text-start font-normal">{t("instances:assets.name")}</th>
                <th className="py-1 text-start font-normal">{t("instances:assets.size")}</th>
                <th className="py-1 text-start font-normal">{t("instances:assets.updated")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.name} className="border-t border-line">
                  <td className="py-1 font-mono">{a.name}</td>
                  <td className="py-1">{formatBytes(a.size)}</td>
                  <td className="py-1">
                    {formatDateTime(a.updatedAt)} · {a.updatedBy}
                  </td>
                  <td className="py-1 text-end">
                    <button type="button" className="btn-link text-xs" onClick={() => void navigator.clipboard?.writeText(`{ "shape": "gltf", "asset": "${a.name}" }`)}>
                      {t("instances:assets.copy")}
                    </button>{" "}
                    <button type="button" className="btn-link text-xs text-error" onClick={() => void remove(a.name)}>
                      {t("instances:assets.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
