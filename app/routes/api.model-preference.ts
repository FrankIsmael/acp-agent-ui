import { data } from "react-router";
import type { Route } from "./+types/api.model-preference";
import { getLastConfigOptions } from "~/.server/acp";
import { modelPreference } from "~/.server/model-preference";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  if (request.headers.get("sec-fetch-site") === "cross-site") return data({ error: "forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const model = getLastConfigOptions().find(option => option.category === "model" || option.id === "model");
  const values = ((model?.options ?? []) as any[]).flatMap(option => "group" in option ? option.options : [option]);
  if (typeof body?.value !== "string" || body.value.length > 256 || !values.some(option => option.value === body.value)) {
    return data({ error: "Ese modelo no está disponible. Abre una conversación para actualizar la lista." }, { status: 400 });
  }
  return data({ value: body.value }, { headers: { "Set-Cookie": await modelPreference.serialize(body.value, { secure: new URL(request.url).protocol === "https:" }) } });
}
