import type en from '../en/palette';

const es: typeof en = {
    title: 'Paleta de comandos',
    inputLabel: 'Buscar servidores, pestañas y comandos',
    placeholder: 'Escribe un servidor, una pestaña o un comando…',
    results: 'Resultados',
    empty: 'No hay coincidencias',
    current: '(actual)',
    goToTab: 'Ir a {tab}',
    sections: {
        servers: 'Servidores',
        tabs: 'Pestañas',
        actions: 'Herramientas',
        commands: 'Comandos'
    },
    hints: {
        navigate: 'para moverte',
        run: 'para ejecutar',
        close: 'para cerrar'
    },
    commands: {
        newConnection: 'Nueva conexión',
        importSshConfig: 'Importar hosts de ~/.ssh/config',
        editActive: 'Editar {name}',
        closeActive: 'Cerrar {name}',
        showChat: 'Mostrar el chat de IA',
        hideChat: 'Ocultar el chat de IA',
        settings: 'Abrir los ajustes',
        exportImport: 'Exportar o importar la configuración',
        appearance: 'Ajustes de apariencia',
        keychain: 'Llavero: identidades y claves SSH',
        theme: 'Tema: {theme}',
        language: 'Idioma: {language}',
        systemLanguage: 'Predeterminado del sistema'
    }
};

export default es;
