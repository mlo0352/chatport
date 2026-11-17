import { useEffect, useRef, useState } from "react";
import {
  Image,
  Download,
  X,
  ZoomIn,
  ZoomOut,
  Copy,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { rpc, desktop } from "./api";
import type { Attachment } from "./types";
const requests = new Map<
  string,
  Promise<{ dataUrl: string; mime: string; bytes: number }>
>();
function read(chatId: string, id: string) {
  const key = chatId + ":" + id;
  let value = requests.get(key);
  if (!value) {
    value = rpc("image.read", { chatId, id }).catch((e) => {
      requests.delete(key);
      throw e;
    });
    requests.set(key, value);
    if (requests.size > 12) requests.delete(requests.keys().next().value!);
  }
  return value;
}
export default function Attachments({
  chatId,
  items,
}: {
  chatId: string;
  items: Attachment[];
}) {
  return (
    <div className="attachments">
      {items.map((a) => (
        <ImageCard key={a.id} chatId={chatId} attachment={a} />
      ))}
    </div>
  );
}
function ImageCard({
  chatId,
  attachment: a,
}: {
  chatId: string;
  attachment: Attachment;
}) {
  const [data, setData] = useState<{
      dataUrl: string;
      mime: string;
      bytes: number;
    }>(),
    [error, setError] = useState(""),
    [opened, setOpened] = useState(false),
    [zoom, setZoom] = useState(false),
    [busy, setBusy] = useState(false);
  const card = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setData(undefined);
    setError("");
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          read(chatId, a.id)
            .then((d) => live && setData(d))
            .catch((e) => live && setError(e.message));
        }
      },
      { rootMargin: "150px" },
    );
    if (card.current) observer.observe(card.current);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [chatId, a.id]);
  useEffect(() => {
    if (!opened) return;
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpened(false);
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [opened]);
  async function saveImage() {
    setBusy(true);
    try {
      if (desktop) {
        const file = await save({
          defaultPath: a.name,
          filters: [
            {
              name: "Image",
              extensions: [
                a.mime.split("/")[1] === "jpeg" ? "jpg" : a.mime.split("/")[1],
              ],
            },
          ],
        });
        if (file)
          await rpc("image.save", { chatId, id: a.id, destination: file });
      } else if (data) {
        const link = document.createElement("a");
        link.href = data.dataUrl;
        link.download = a.name;
        link.click();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={"image-card " + (error ? "unavailable" : "")}
        ref={card}
        aria-label={"Open image " + a.name}
        onClick={() => setOpened(true)}
      >
        {data ? (
          <img src={data.dataUrl} alt={a.name} loading="lazy" />
        ) : (
          <div className="image-placeholder">
            {error ? (
              <AlertCircle size={20} />
            ) : (
              <LoaderCircle className="spin" size={18} />
            )}
            <span>{error ? "Image unavailable" : "Loading image…"}</span>
          </div>
        )}
        <span className="image-caption">
          <Image size={13} />
          <span>{a.name}</span>
          <ZoomIn size={13} />
        </span>
      </button>
      {opened && (
        <div
          className="image-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={"Image " + a.name}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpened(false);
          }}
        >
          <section className="image-viewer">
            <header>
              <div>
                <Image size={16} />
                <strong>{a.name}</strong>
                {data && <span>{Math.round(data.bytes / 1024)} KB</span>}
              </div>
              <div>
                <button
                  className="button"
                  disabled={!data}
                  onClick={() => setZoom(!zoom)}
                >
                  {zoom ? <ZoomOut size={15} /> : <ZoomIn size={15} />}{" "}
                  {zoom ? "Fit" : "Actual size"}
                </button>
                <button
                  className="button"
                  disabled={!data || busy}
                  onClick={saveImage}
                >
                  <Download size={15} />
                  Save image
                </button>
                <button
                  className="icon-button"
                  aria-label="Close image"
                  onClick={() => setOpened(false)}
                >
                  <X />
                </button>
              </div>
            </header>
            <div className={"image-canvas " + (zoom ? "actual" : "")}>
              {data ? (
                <img src={data.dataUrl} alt={a.name} />
              ) : (
                <div className="empty-state">
                  <AlertCircle />
                  <p>{error || "Loading image…"}</p>
                </div>
              )}
            </div>
            {error && data && <p className="image-error">{error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
