function normalizeAiScopeText(value: string): string {
    return (value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

export function looksSpanish(text: string): boolean {
    const normalized = normalizeAiScopeText(text);
    return /(^|\b)(hola|quiero|necesito|ayuda|servidor|script|comando|explica|desarrolla|arregla|instala|configura|docker|linux|windows|devops|monitoriza|monitorizacion|logs|backup|despliegue|scraping|webscraping)(\b|$)/.test(normalized);
}

export function buildOutOfScopeResponse(message: string): string {
    if (looksSpanish(message)) {
        return "Solo puedo ayudar con tareas de SysAdmin, administracion de servidores y DevOps. Puedo crear comandos o scripts para despliegues, Docker, backups, logs, monitorizacion, redes, hardening, automatizacion, CI/CD y troubleshooting de infraestructura. No puedo ayudar con peticiones de desarrollo general como web scraping, apps, bots, webs, tareas academicas o scripting no relacionado con servidores.";
    }

    return "I can only help with SysAdmin, server management, and DevOps tasks. I can create commands or scripts for deployments, Docker, backups, logs, monitoring, networking, hardening, automation, CI/CD, and infrastructure troubleshooting. I can't help with general development requests such as web scraping, apps, bots, websites, academic tasks, or scripting unrelated to servers.";
}

export function isOutOfScopeAiRequest(message: string, context?: string): boolean {
    const normalizedMessage = normalizeAiScopeText(message);
    const normalizedContext = normalizeAiScopeText(context || "");
    const combined = `${normalizedMessage}\n${normalizedContext}`;

    const infraKeywords = [
        "sysadmin", "system administrator", "server", "servidor", "infra", "infrastructure", "devops",
        "docker", "kubernetes", "k8s", "compose", "nginx", "apache", "caddy", "proxy", "reverse proxy",
        "ssh", "rdp", "powershell", "bash", "shell", "systemd", "service", "daemon", "cron",
        "backup", "restore", "snapshot", "monitor", "monitoring", "observability", "metrics",
        "logs", "logging", "deploy", "deployment", "rollout", "rollback", "ansible", "terraform",
        "cloud-init", "ci/cd", "pipeline", "gitlab ci", "github actions", "firewall", "ufw",
        "iptables", "dns", "ssl", "tls", "certbot", "certificate", "network", "networking",
        "port", "sftp", "ftp", "s3", "bucket", "linux", "windows server", "hardening", "audit",
        "vm", "vps", "hostname", "disk", "filesystem", "raid", "postgres", "mysql", "mariadb", "redis"
    ];

    const disallowedKeywords = [
        "web scraping", "webscraping", "scraping", "scraper", "selenium", "beautifulsoup",
        "playwright", "puppeteer", "discord bot", "telegram bot", "twitter bot", "instagram bot",
        "shopify", "landing page", "portfolio", "curriculum", "cv", "resume", "poem", "story",
        "novel", "creative writing", "translate", "translation", "email marketing", "seo",
        "social media", "trading bot", "game", "videojuego", "juego", "web app", "mobile app",
        "react app", "next.js app", "flutter app", "android app", "ios app", "school project",
        "academic", "universidad", "homework", "tarea", "essay", "redaccion"
    ];

    const genericCodingOnlyKeywords = [
        "python script", "javascript", "typescript", "html", "css", "frontend", "backend", "api",
        "web", "website", "app", "application", "program", "programa", "code", "codigo"
    ];

    const hasInfraKeyword = infraKeywords.some(keyword => combined.includes(keyword));
    const hasDisallowedKeyword = disallowedKeywords.some(keyword => normalizedMessage.includes(keyword));
    const hasGenericCodingKeyword = genericCodingOnlyKeywords.some(keyword => normalizedMessage.includes(keyword));

    if (hasDisallowedKeyword && !hasInfraKeyword) {
        return true;
    }

    if (hasGenericCodingKeyword && !hasInfraKeyword) {
        return true;
    }

    return false;
}
