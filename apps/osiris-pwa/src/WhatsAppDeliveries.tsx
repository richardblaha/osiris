import { useEffect, useState } from "react";
import { t } from "i18next";
import { api } from "./api.ts";
import { formatDateTime } from "./i18n.ts";
import { ErrorNotice, Pending } from "./Scope.tsx";

const DELIVERY = ["accepted", "sent", "delivered", "read", "failed"] as const;
const delivery = (s: string) => ((DELIVERY as readonly string[]).includes(s) ? t(`activity:delivery.${s as (typeof DELIVERY)[number]}`) : s);
const time = (value: number) => (value ? formatDateTime(value, { dateStyle: "medium", timeStyle: "medium" }) : t("activity:unknownTime"));

/** WhatsApp's delivery reports for the user's verified number (control keeps them; Profile > WhatsApp). */
export function WhatsAppDeliveries() {
  const [deliveries, setDeliveries] = useState<{ status: string; at: number }[]>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.security.whatsappDeliveries().then(setDeliveries, (e: Error) => setError(e.message)), []);
  return (
    <section className="space-y-3">
      <h2 className="section-header">{t("activity:deliveries")}</h2>
      <ErrorNotice error={error} />
      {!deliveries && !error && <Pending />}
      <ul className="divide-y divide-line">
        {deliveries?.map((d, i) => (
          <li key={i} className="py-2 text-sm">
            {time(d.at)} · {delivery(d.status)}
          </li>
        ))}
      </ul>
    </section>
  );
}
