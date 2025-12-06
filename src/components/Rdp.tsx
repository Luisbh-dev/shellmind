import { Monitor, Download } from 'lucide-react';

interface RdpProps {
  server: any;
}

export default function RdpComponent({ server }: RdpProps) {
  
  const downloadRdpFile = () => {
      const rdpContent = `
full address:s:${server.ip}:${server.port || 3389}
username:s:${server.username}
screen mode id:i:2
session bpp:i:32
compression:i:1
keyboardhook:i:2
audiomode:i:0
redirectprinters:i:0
redirectcomports:i:0
redirectsmartcards:i:0
redirectclipboard:i:1
redirectposdevices:i:0
drivestoredirect:s:
displayconnectionbar:i:1
autoreconnection enabled:i:1
authentication level:i:2
prompt for credentials:i:1
negotiate security layer:i:1
remoteapplicationmode:i:0
alternate shell:s:
shell working directory:s:
gatewayhostname:s:
gatewayusagemethod:i:4
gatewaycredentialssource:i:4
gatewayprofileusagemethod:i:0
promptcredentialonce:i:1
use redirection server name:i:0
rdgiskdcproxy:i:0
kdcproxyname:s:
      `.trim();

      const blob = new Blob([rdpContent], { type: 'application/x-rdp' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${server.name.replace(/\s+/g, '_')}.rdp`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  };

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-[#0a0a0a] text-zinc-400 gap-6">
        <div className="w-24 h-24 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-800 shadow-2xl">
            <Monitor className="w-10 h-10 text-blue-500" />
        </div>
        
        <div className="text-center max-w-md space-y-2">
            <h2 className="text-xl font-bold text-zinc-200">Remote Desktop Connection</h2>
            <p className="text-sm text-zinc-500">
                Web-based RDP rendering is currently <strong>Work in Progress</strong>.
                <br/>
                In the meantime, you can download the connection file to use your native client.
            </p>
        </div>

        <div className="flex flex-col gap-3 w-64">
            <button 
                onClick={downloadRdpFile}
                className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-md font-medium transition-colors shadow-lg shadow-blue-900/20"
            >
                <Download className="w-4 h-4" />
                Download .rdp File
            </button>
            
            <div className="text-xs text-center text-zinc-600 mt-2">
                Connecting to <strong>{server.ip}</strong> as <strong>{server.username}</strong>
            </div>
        </div>
    </div>
  );
}
