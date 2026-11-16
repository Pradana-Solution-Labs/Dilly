import YAML from "yaml";

export interface ExtractedEnvVar {
  key: string;
  defaultValue: string;
  isSecret: boolean;
}

const SECRET_REGEX = /(SECRET|PASSWORD|PASS|TOKEN|KEY|PRIVATE|AUTH|CREDENTIAL)/i;

/**
 * Extracts environment variables from raw docker-compose.yml content.
 * Checks both variable interpolation (${VAR} / ${VAR:-default})
 * and service environment blocks (mapping and list formats).
 */
export function extractComposeEnvVars(composeYaml: string): ExtractedEnvVar[] {
  if (!composeYaml || !composeYaml.trim()) {
    return [];
  }

  const varMap = new Map<string, { defaultValue: string; isSecret: boolean }>();

  // 1. Regex interpolation scanner: ${VAR_NAME} or ${VAR_NAME:-default}
  const interpolationRegex = /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g;
  let match: RegExpExecArray | null;

  while ((match = interpolationRegex.exec(composeYaml)) !== null) {
    const key = match[1];
    const defaultValue = match[2] ?? "";
    if (key && !varMap.has(key)) {
      varMap.set(key, {
        defaultValue,
        isSecret: SECRET_REGEX.test(key),
      });
    }
  }

  // 2. YAML AST Parser for services.*.environment
  try {
    const doc = YAML.parse(composeYaml);
    if (doc && typeof doc === "object" && doc.services && typeof doc.services === "object") {
      for (const serviceName of Object.keys(doc.services)) {
        const serviceObj = doc.services[serviceName];
        if (!serviceObj || typeof serviceObj !== "object") continue;

        const envBlock = serviceObj.environment;
        if (!envBlock) continue;

        if (Array.isArray(envBlock)) {
          // List format: - FOO=BAR or - FOO
          for (const item of envBlock) {
            if (typeof item !== "string") continue;
            const eqIndex = item.indexOf("=");
            let key = item;
            let val = "";
            if (eqIndex !== -1) {
              key = item.slice(0, eqIndex).trim();
              val = item.slice(eqIndex + 1).trim();
            } else {
              key = item.trim();
            }

            // Remove any trailing interpolation wrappers if present in value
            if (val.startsWith("${") && val.endsWith("}")) {
              const innerMatch = /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/.exec(val);
              if (innerMatch) {
                val = innerMatch[2] ?? "";
              }
            }

            if (key && !varMap.has(key)) {
              varMap.set(key, {
                defaultValue: val,
                isSecret: SECRET_REGEX.test(key),
              });
            }
          }
        } else if (typeof envBlock === "object") {
          // Mapping format: FOO: BAR
          for (const [key, rawVal] of Object.entries(envBlock)) {
            let val = rawVal !== null && rawVal !== undefined ? String(rawVal) : "";
            if (val.startsWith("${") && val.endsWith("}")) {
              const innerMatch = /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/.exec(val);
              if (innerMatch) {
                val = innerMatch[2] ?? "";
              }
            }

            if (key && !varMap.has(key)) {
              varMap.set(key, {
                defaultValue: val,
                isSecret: SECRET_REGEX.test(key),
              });
            }
          }
        }
      }
    }
  } catch (err) {
    // If YAML parse fails, fallback to regex results
    console.warn("[EnvParser] YAML parse warning:", err);
  }

  return Array.from(varMap.entries()).map(([key, info]) => ({
    key,
    defaultValue: info.defaultValue,
    isSecret: info.isSecret,
  }));
}
