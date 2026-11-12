# CSY Agent Quick Start

[Start here](../READ-ME.md) | [简体中文](使用说明-中文版.md)

## First-use order

**Prepare the complete application package → install the required Harness version and dependencies → prepare BC HTTPS and MCP configuration → open CSY.exe and save the BC connection → run connect.cmd to configure integration → configure your model and chat.**

`connect.cmd` connects an existing Harness installation to the Gateway by configuring the plugin and CSY Agent. It does not download or install Harness. Normally, run it only for initial setup; use `Start-Harness.cmd` on later starts.

## Prerequisites

Install the required software before following the connection steps below. Do not reinstall software already installed at compatible versions.

1. **Windows 10/11 (64-bit) and a browser.**
2. **Complete application folder (DPBCMCP, containing CSY.exe):** Obtain the provider's complete Windows x64 ZIP and extract it to a writable location. Once published on GitHub, use the application ZIP attached to the Release; the automatically generated Source code ZIP may not contain the runtime files.
3. **DeepSeek Harness:** DSH **0.1.2-alpha.1** / Cordis **4.0.1**; sign-in details.
4. **Node.js 24.**
5. **Python 3.12+.**
6. **PowerShell 7.x (64-bit):** [Microsoft installation guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows). Choose the stable x64 release. The current integration scripts require this version; it can coexist with the Windows PowerShell 5.1 included with Windows.
7. **BC connection details:** MCP URL, company name, username, and password or Web Service Access Key.
8. **Model configuration:** Model name, API key, service URL.

The Gateway EXE itself includes Python. Harness, Node.js, external Python/PowerShell, BC, model services and credentials are not included. Setup may ask for installed program paths; it does not install these dependencies.

### If you cannot use PowerShell 7

The integration script source is included with the application: the entry points are `connect.cmd` and `Start-Harness.cmd` in the application root folder, and the main integration logic is in `integration/harness-integration/official-plugin/`.

If you cannot use PowerShell 7, you can modify the relevant scripts yourself or with your own AI Agent to try adapting them to your existing PowerShell version. Other versions have not been verified. After making changes, test the complete integration and startup flows yourself; changing only the version check does not guarantee compatibility.

### Prepare the BC HTTPS certificate and Windows trust

**What is required:** To connect to BC MCP with the current CSY application, the BC service must provide a valid HTTPS server certificate, and the computer running CSY must trust it. The certificate's hostname must match the MCP URL, and the certificate must not be expired. These requirements also apply to local testing.

**What it is:** This certificate verifies the BC server's identity and enables an encrypted connection. It comes from your own BC environment. CSY does not include or automatically configure it.

**How to prepare it:** When creating a Docker test container with BcContainerHelper, add `-useSSL` to enable HTTPS and `-installCertificateOnHost` to add the container certificate to the host's **Trusted Root Certification Authorities** store. Approve administrator access when prompted. If CSY runs on another computer, configure certificate trust on that computer as well.

- [Microsoft BcContainerHelper parameters and implementation](https://github.com/microsoft/navcontainerhelper/blob/main/ContainerHandling/New-NavContainer.ps1)
- [Microsoft BC On-Prem certificate configuration guide](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/deployment/implement-security-certificates-production-environment)

## Configure MCP in BC

Prepare a **BC On-Prem test environment with native MCP support** and a BC account for the connection. This version of CSY does not support BC Online.

1. In BC, search for and open **Model Context Protocol (MCP) Server Configurations**.
2. Select **New** and enter a configuration name.
3. Enable **API Tools**, add the API objects you want the agent to use, and set the allowed operations for each object, such as read, create, modify, delete or actions.
4. Enable **Active**, then select **Set as Default**. The current Gateway uses the default BC MCP configuration.

**The API objects and operations enabled in MCP determine the available business capabilities; the connection account must also have the corresponding permissions.** Add MCP-supported API objects, not arbitrary BC pages or Codeunits. For example, reading customers requires a customer API object with read access; modifying customers also requires the modify operation and account permissions.

To limit the object scope to your manually added list, keep **Discover Read-Only Objects** off. Enabling it may also discover API objects that were not manually added but that the account can read.

See [Microsoft's MCP configuration guide](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/configure-mcp-server). That guide applies to Online; On-Prem screens and available features depend on the installed version.

## Copy the BC MCP URL

1. Open the MCP configuration you set as default and select **Advanced → Connection String**.
2. Copy only the **url value**, not the entire JSON configuration.

Enter this address in the Gateway's **BC MCP HTTPS URL** field. Normally, you do not need to construct the address or look up the port yourself.

Also prepare the target **BC company name, username, and password or Web Service Access Key**.

## Save the BC connection

1. Open **CSY.exe** in the **application root folder**. The Gateway page opens automatically. Keep the application window open.
2. Enter **BC MCP HTTPS URL**, **Company**, **User name**, and **Password or Web Service Access Key**.
3. Select **Save connection**. `Connection saved locally.` confirms the save.

## First-time Harness setup

**Already installed DeepSeek Harness? Open CSY.exe and save the BC connection, then run connect.cmd. If Harness is not found automatically, provide its installation folder. Setup checks the versions and required files and explains recognized failures.**

1. Open **connect.cmd** in the **application root folder**.
2. Enter `yes` and press Enter to confirm setup.
3. Setup first tries to find Harness automatically. At the `Harness installation folder` prompt, enter the local **Harness installation directory**, for example `D:\Apps\deepseek-harness` (an example only). Do not enter a browser URL, shortcut, or sign-in details. If Python or PowerShell is requested separately, enter that program's full path.
4. Setup checks DSH **0.1.2-alpha.1**, Cordis **4.0.1**, and required files. **Setup complete** confirms completion. **Already configured** means an integration configuration exists, not that the connection was verified; open **Start-Harness.cmd** if needed and perform the read-only query.
5. Open the Harness address shown by setup, normally [http://127.0.0.1:3080](http://127.0.0.1:3080).

### When Harness cannot be found or connected

| Message / error code | Meaning and action |
|---|---|
| `HARNESS_NOT_FOUND` | Automatic discovery failed; enter the installation folder when prompted. |
| `HARNESS_ROOT_INVALID` | The supplied directory could not be recognized as a Harness installation; check the path. |
| `HARNESS_INSTALL_INCOMPLETE` | A related installation was found, but required files or dependencies are missing. Use a complete installation; source checkouts must also be built. |
| `HARNESS_VERSION_UNSUPPORTED` | The versions do not match. DSH 0.1.2-alpha.1 / Cordis 4.0.1 are required. |
| `PYTHON_NOT_FOUND` / `POWERSHELL_NOT_FOUND` | A compatible runtime was not found. Supply the executable path for Python 3.12+ or 64-bit PowerShell 7 when prompted. |

Setup may show the corresponding explanation first; a final failure displays an error code. Unrecognized errors may have only a generic failure code. Keep the displayed message for the provider to inspect. Setup does not install, repair, or upgrade software automatically.

**Providing a path does not make every installation method compatible.** This integration targets Harness **Web**; Desktop is not yet adapted. Source builds and npm installations must meet the version and directory requirements; npx may use a cache directory. Installation methods have not all been individually validated. Passing setup checks is a prerequisite for integration, not proof of a complete business workflow.

## CSY Agent preset

**No manual copying or moving of preset files is required.** A successful first-time `connect.cmd` setup creates the CSY Agent preset and configures its integration automatically.

1. Wait for **Setup complete**. **Already configured** means an integration configuration already exists.
2. Open the Harness address shown by setup; refresh the page if it was already open.
3. Choose a workspace and start a new session. Select **CSY Agent** in the agent/preset selector, then select a configured model.

The default preset directory is `%USERPROFILE%\.dsh\.agent-presets\bc-agent`. With a custom Harness user directory, the preset is under that directory's `.agent-presets\bc-agent`. Its display name is **CSY Agent**; its internal folder name remains `bc-agent` and does not need renaming.

If **CSY Agent** is missing from the list, check whether setup reported a failure and whether you opened the Harness address shown by setup. Do not move preset files arbitrarily to resolve this.

## Configure the model

1. In Harness, select **Settings** > **Models**.
2. Select **Edit** beside your provider, or **Add provider** if it is not listed.
3. Enter your model configuration details.
4. Select **Apply**.

## Start a chat

1. Select your working folder through **Choose workspace**.
2. Select **New Session**.
3. Select your model and **CSY Agent**.
4. Send this read-only connection check:

   > Use the available tools and their required parameters to read one existing sales order. Return its order number, customer and status. Do not create, modify, delete or post anything.

## Start again later

Use the same Windows account and original folder.

1. Open **CSY.exe**.
2. Open **Start-Harness.cmd** and supply installation paths if prompted.
3. Open the displayed Harness address.

To stop the Gateway, enter `Q` in its window and press Enter.

## Invalid binding or a saved connection change

If a tool reports `The Gateway binding is no longer valid.`, explicitly refresh the binding:

1. Keep `CSY.exe` running with the intended BC connection saved.
2. Exit the corresponding Harness host process; closing a browser tab does not stop it.
3. Open **cmd** in this application folder and run:

   ```cmd
   call connect.cmd --refresh-binding && call Start-Harness.cmd
   ```

4. Enter `yes`; after success, press any key to continue. Open the displayed Harness address, create a new session and select **CSY Agent**.
5. Repeat the read-only query above and confirm a real BC result.

The scripts discover PowerShell 7 automatically. If prompted, supply the full path to your own installed `pwsh.exe`; do not copy someone else's user directory.

`Already configured` confirms installation state only, **not binding validity or successful BC authentication**. If BC still returns `403` or `BC_REJECTED`, retain the error code and check BC permissions, MCP configuration and connection details. This alone does not establish that another agent has occupied the connection.

## Files and folders

| File or folder | Purpose |
|---|---|
| `CSY.exe` | Main Gateway application |
| `connect.cmd` | First-time Harness setup |
| `Start-Harness.cmd` | Daily Harness startup |
| `docs/` | Chinese and English guides, file checksums |
| `_internal/` | Gateway runtime dependencies |
| `integration/` | Files required for Harness integration |
| `data/` | Local connection and settings created during use |
| `licenses/` | Third-party licenses |
| `THIRD-PARTY-NOTICES.txt` | Third-party notices |

Keep the entire folder together. DPBCMCP is the folder name; the application remains `CSY.exe`. `_internal` and `integration` must stay beside the application.

File checksums are in [docs/FILES.sha256](FILES.sha256).

## Address and connection

Default Gateway address: [http://127.0.0.1:8765](http://127.0.0.1:8765).

To select another available port on first launch, use `CSY.exe --port <free-port>`, replacing `<free-port>` with the port number. A newly saved address takes effect on the next launch.

Do not use a port or profile occupied by another Gateway deployment. Saving connection data does not authenticate BC. Enabled BC tools can change business data.

## Local data and sharing

Local connections and settings are stored in `data` beside `CSY.exe`. Windows DPAPI ties protected data to the Windows user and computer.

Share a complete distribution folder without personal data, never a used `data` folder. This copy is distributed as a complete folder.

## Signing and verification status

This application is unsigned; Windows may show an unknown publisher or security prompt. If Windows blocks it, contact the provider.

No installer deployment, service installation, firewall change, dependency upgrade or startup registration is performed. Verification on a clean computer remains pending.
