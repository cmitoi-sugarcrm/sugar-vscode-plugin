import * as vscode from 'vscode';
import axios from 'axios';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface Issue {
    key: string;
    fields: {
        summary: string;
        description: string;
        status: {
            name: string;
        };
    };
}

export function activate(context: vscode.ExtensionContext) {
    const sugarSidebarProvider = new SugarSidebarProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'sugarSidebarView',
            sugarSidebarProvider
        )
    );

    // Command to set API token
    context.subscriptions.push(
        vscode.commands.registerCommand('sugarPlugin.setApiToken', async () => {
            const apiToken = await vscode.window.showInputBox({
                prompt: "Enter your Jira API token",
                ignoreFocusOut: true,
                password: true
            });
            if (apiToken) {
                await context.secrets.store('jiraApiToken', apiToken);
                vscode.window.showInformationMessage('Jira API token saved successfully.');
            }
        })
    );

    // Command to set GitHub token
    context.subscriptions.push(
        vscode.commands.registerCommand('sugarPlugin.setGithubToken', async () => {
            const githubToken = await vscode.window.showInputBox({
                prompt: "Enter your GitHub API token",
                ignoreFocusOut: true,
                password: true
            });
            if (githubToken) {
                await context.secrets.store('githubToken', githubToken);
                vscode.window.showInformationMessage('GitHub token saved successfully.');
            }
        })
    );


    // Command to set Jira username
    context.subscriptions.push(
        vscode.commands.registerCommand('sugarPlugin.setJiraUsername', async () => {
            const username = await vscode.window.showInputBox({
                prompt: "Enter your Jira username",
                ignoreFocusOut: true
            });
            if (username) {
                await vscode.workspace.getConfiguration().update('sugarPlugin.jiraUsername', username, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('Jira username saved successfully.');
            }
        })
    );
}

class SugarSidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly context: vscode.ExtensionContext) { }

    async resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };

        try {
            const config = await this.getJiraConfig();
            const jiraDomain = config.jiraDomain;
            webviewView.webview.html = this.getHtmlForWebview(jiraDomain);

            // Display the active task each time the webview is loaded
            await this.displayActiveTask(webviewView, config.jiraUsername);
            await this.displayChangedFiles(webviewView); // Initial load of changed files

            // Listen for visibility changes to refresh the view when it becomes active
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.displayActiveTask(webviewView, config.jiraUsername);
                    this.displayChangedFiles(webviewView); // Refresh changed files list on visibility
                }
            });

            // Listen for text document changes to update the list of changed files
            vscode.workspace.onDidChangeTextDocument(() => {
                if (webviewView.visible) {
                    this.displayChangedFiles(webviewView);
                }
            });

            // Set up a periodic refresh to check for changes using `git status`
            setInterval(() => {
                if (webviewView.visible) {
                    this.displayChangedFiles(webviewView);
                }
            }, 5000); // Refresh every 5 seconds
        } catch (error) {
            console.error("Failed to load Jira configuration:", error);
            vscode.window.showErrorMessage("Failed to load Jira configuration. Please check your settings.");
        }

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            const config = await this.getJiraConfig();

            if (message.command === 'searchJira') {
                const ticketDetails = await this.searchJiraTicket(message.ticket);
                webviewView.webview.postMessage({ command: 'displayTicketDetails', ticketDetails });
            } else if (message.command === 'startWork') {
                const { ticket, summary } = message;
                await this.startWorkOnTicket(ticket, summary);
                this.context.globalState.update('inProgressTicket', ticket);
                await this.displayActiveTask(webviewView, config.jiraUsername);
            } else if (message.command === 'createPR') {
                await this.createPullRequest();
            } else if (message.command === 'createBuild') {
                await this.createBuild();
            } else if (message.command === 'stageFile') {
                await this.stageFile(message.file);
                this.displayChangedFiles(webviewView);
            } else if (message.command === 'unstageFile') {
                await this.unstageFile(message.file);
                this.displayChangedFiles(webviewView);
            } else if (message.command === 'viewChanges') {
                this.openFileDiff(message.file);
            } else if (message.command === 'buildDockerImage') {
                await this.buildDockerImage(this.context);
            } else if (message.command === 'runDockerContainer') {
                await this.runDockerContainer();
            }
        });
    }

    private async buildDockerImage(context: vscode.ExtensionContext) {
        // Use context.extensionPath to get the root directory of the plugin
        const dockerfilePath = path.join(context.extensionPath, 'Dockerfile');
        const buildContext = path.dirname(dockerfilePath); // The build context is the directory containing Dockerfile

        // Check if Dockerfile exists in the plugin's root folder
        if (!fs.existsSync(dockerfilePath)) {
            vscode.window.showErrorMessage(`Dockerfile not found at ${dockerfilePath}`);
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Building Docker Image",
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: "Building 'sugar-dev' image from Dockerfile in plugin root..." });

                return new Promise<void>((resolve, reject) => {
                    // Construct Docker command with absolute path to Dockerfile
                    exec(`docker build -t sugar-dev -f "${dockerfilePath}" "${buildContext}"`, (error, stdout, stderr) => {
                        if (error) {
                            vscode.window.showErrorMessage(`Failed to build Docker image: ${stderr}`);
                            console.error("Error building Docker image:", error);
                            reject(error);
                            return;
                        }
                        vscode.window.showInformationMessage("Docker image 'sugar-dev' built successfully.");
                        resolve();
                    });
                });
            }
        );
    }



    private async runDockerContainer() {
        const ticketNumber = this.context.globalState.get<string>('inProgressTicket');
        const version = await vscode.window.showInputBox({
            prompt: "Enter the version number",
            value: "14.2.0",  // Default version
        }) || "14.2.0";  // Fallback to default if input is empty

        if (!ticketNumber) {
            vscode.window.showErrorMessage("No active ticket in progress. Please start a ticket before running the container.");
            return;
        }

        const containerName = `${ticketNumber}`;

        // Get the path to the Mango folder in the workspace
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        const mangoPath = workspacePath

        // Update run command to mount the Mango folder from the workspace to /app in the container
        const runCommand = `docker run -d -p 80:80 -p 3306:3306 -p 9200:9200 --name ${containerName} -v ${mangoPath}:/app sugar-dev`;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Starting Docker Container ${containerName}`,
                cancellable: false,
            },
            async (progress) => {
                try {
                    progress.report({ message: "Running container..." });

                    // Run the container with the specified name and settings
                    await this.execShellCommand(runCommand);
                    vscode.window.showInformationMessage(`Docker container '${containerName}' started successfully.`);

                    // Get the container ID of the running 'sugar-dev' container by name
                    const containerId = await this.execShellCommand(`docker ps -qf "name=${containerName}"`);
                    if (!containerId) {
                        throw new Error(`Could not retrieve container ID for ${containerName}.`);
                    }

                    // Commands to run inside the container without TTY
                    const execCommands = `docker exec -i ${containerId.trim()} sh -c "cd /app/build/rome && php build.php --ver=${version} --build_dir=/var/www/html/sugar/ && cd /var/www/html && chmod -R 777 sugar/* && cd sugar/ent/sugarcrm && composer install && yarn && yarn build:tw && cd sidecar && yarn && gulp build"`;

                    progress.report({ message: "Setting up the container environment..." });
                    await this.execShellCommand(execCommands);

                    vscode.window.showInformationMessage(`Container '${containerName}' is now running and fully configured.`);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to start or configure the Docker container: ${errorMessage}`);
                    console.error("Error running Docker container:", error);
                }
            }
        );
    }



    private async execShellCommand(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout ? stdout : stderr);
            });
        });
    }





    // Function to display the list of changed files in the webview
    private async displayChangedFiles(webviewView: vscode.WebviewView) {
        const changedFiles = await this.getChangedFiles();
        webviewView.webview.postMessage({ command: 'displayChangedFiles', changedFiles });
    }

    private async getChangedFiles(): Promise<{ staged: string[]; unstaged: string[] }> {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        return new Promise((resolve) => {
            exec('git status --porcelain', { cwd: workspacePath }, (error, stdout) => {
                if (error) {
                    console.error('Error getting changed files:', error);
                    resolve({ staged: [], unstaged: [] });
                    return;
                }

                const staged: string[] = [];
                const unstaged: string[] = [];
                const lines = stdout.split('\n').filter(line => line.trim());

                lines.forEach(line => {
                    const status = line.slice(0, 2); // Get the two-character status
                    const file = line.slice(3).trim(); // Get the file path

                    if (status[0] === 'M' || status[0] === 'A') {
                        // If the first character is 'M' or 'A', the file is staged
                        staged.push(file);
                    }

                    if (status[1] === 'M') {
                        // If the second character is 'M', the file is modified but unstaged
                        unstaged.push(file);
                    }
                });

                resolve({ staged, unstaged });
            });
        });
    }



    // Function to stage a specific file
    private async stageFile(file: string) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        exec(`git add ${file}`, { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to stage file ${file}: ${stderr}`);
                console.error(`Error staging file ${file}:`, error);
            } else {
                vscode.window.showInformationMessage(`Staged file ${file}`);
            }
        });
    }

    // Function to unstage a specific file
    private async unstageFile(file: string) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        exec(`git reset ${file}`, { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to unstage file ${file}: ${stderr}`);
                console.error(`Error unstaging file ${file}:`, error);
            } else {
                vscode.window.showInformationMessage(`Unstaged file ${file}`);
            }
        });
    }

    private async openFileDiff(file: string) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        const filePath = `${workspacePath}/${file}`;

        // Create a temporary file to store the previous version
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, path.basename(file));
        const tempUri = vscode.Uri.file(tempFilePath);

        // Get the previous version of the file from HEAD
        exec(`git show HEAD:${file}`, { cwd: workspacePath }, async (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to retrieve previous version for diff: ${stderr}`);
                console.error(`Error retrieving previous version for diff:`, error);
                return;
            }

            // Write the previous version to the temporary file
            fs.writeFileSync(tempFilePath, stdout);

            // Open the diff with the temporary file as the "old" version and the actual file as the "new" version
            const fileUri = vscode.Uri.file(filePath);
            vscode.commands.executeCommand('vscode.diff', tempUri, fileUri, `Diff: ${path.basename(file)}`)
                .then(
                    () => console.log(`Successfully opened side-by-side diff for ${file}`),
                    (error) => console.error(`Failed to open side-by-side diff for ${file}:`, error)
                );
        });
    }

    // Function to display the active task if there is one in progress
    private async displayActiveTask(webviewView: vscode.WebviewView, username: string) {
        const inProgressTicket = this.context.globalState.get<string>('inProgressTicket');
        if (inProgressTicket) {
            console.log(`Found in-progress ticket: ${inProgressTicket}`);
            const displayButtons = await this.verifyInProgressTicket(inProgressTicket, username);

            // Fetch Git Link 1 from Jira
            const gitLink = await this.getGitLink(inProgressTicket);

            const message = displayButtons
                ? `You have ${inProgressTicket} in progress.`
                : `You have ${inProgressTicket} in progress, but it does not meet the criteria.`;

            // Pass Git Link 1 to the webview
            webviewView.webview.postMessage({ command: 'displayInProgress', message, displayButtons, gitLink });
        } else {
            console.log("No in-progress ticket found.");
        }
    }


    // Helper function to get Git Link 1 from Jira
    private async getGitLink(ticket: string): Promise<string | null> {
        const { jiraDomain, jiraApiToken } = await this.getJiraConfig();
        const url = `${jiraDomain}/rest/api/2/issue/${ticket}?fields=customfield_12000`; // Replace with your field ID
        const jiraConfig = await this.getJiraConfig();

        try {
            const response = await axios.get(url, {
                auth: { username: jiraConfig.jiraUsername, password: jiraApiToken }
            });
            return response.data.fields.customfield_12000 || null; // Return Git Link 1 value if it exists
        } catch (error) {
            console.error("Error retrieving Git Link 1:", error);
            return null;
        }
    }

    // Function to verify the ticket's status and assignee
    private async verifyInProgressTicket(ticket: string, username: string): Promise<boolean> {
        const { jiraDomain, jiraApiToken } = await this.getJiraConfig();
        const url = `${jiraDomain}/rest/api/2/issue/${ticket}?fields=status,assignee`;

        try {
            const response = await axios.get(url, {
                auth: { username, password: jiraApiToken }
            });
            const issue = response.data;
            const isAssignedToUser = issue.fields.assignee && issue.fields.assignee.emailAddress === username;
            const isInProgress = issue.fields.status.name === 'In Progress';
            return isInProgress && isAssignedToUser;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to verify ticket ${ticket} status.`);
            console.error('Error verifying ticket status:', error);
            return false;
        }
    }


    private async createPullRequest() {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        const inProgressTicket = this.context.globalState.get<string>('inProgressTicket');
        const jiraConfig = await this.getJiraConfig();

        if (!inProgressTicket) {
            vscode.window.showErrorMessage("No active ticket in progress.");
            return;
        }

        // Get ticket details from Jira for commit message
        const ticketDetails = await this.searchJiraTicket(inProgressTicket);
        if (!ticketDetails) {
            vscode.window.showErrorMessage(`Failed to retrieve ticket details for ${inProgressTicket}.`);
            return;
        }
        const commitMessage = `${ticketDetails.key}: ${ticketDetails.summary}`;
        const jiraTicketUrl = `${jiraConfig.jiraDomain}/browse/${ticketDetails.key}`; // Construct the Jira ticket URL

        // Step 1: Commit the staged files with the commit message
        exec(`git commit -m "${commitMessage}"`, { cwd: workspacePath }, async (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to create commit: ${stderr}`);
                console.error(`Error creating commit:`, error);
                return;
            }
            vscode.window.showInformationMessage(`Created commit with message: "${commitMessage}"`);

            // Step 2: Push the commit to the current branch
            exec(`git rev-parse --abbrev-ref HEAD`, { cwd: workspacePath }, (branchError, branchName) => {
                if (branchError) {
                    vscode.window.showErrorMessage(`Failed to retrieve branch name: ${branchError.message}`);
                    console.error(`Error getting branch name:`, branchError);
                    return;
                }

                const trimmedBranchName = branchName.trim();
                exec(`git push origin ${trimmedBranchName}`, { cwd: workspacePath }, async (pushError, pushStdout, pushStderr) => {
                    if (pushError) {
                        vscode.window.showErrorMessage(`Failed to push to branch ${trimmedBranchName}: ${pushStderr}`);
                        console.error(`Error pushing to branch:`, pushError);
                        return;
                    }
                    vscode.window.showInformationMessage(`Pushed to branch ${trimmedBranchName}`);

                    // Step 3: Create a pull request using the GitHub API
                    try {
                        const githubToken = await this.context.secrets.get('githubToken');
                        if (!githubToken) {
                            vscode.window.showErrorMessage("GitHub token is not set. Please set it in your environment.");
                            return;
                        }

                        const repoOwner = "cmitoi-sugarcrm"; // Replace with actual GitHub username or org name
                        const repoName = "Mango"; // Replace with actual repository name
                        const prTitle = commitMessage;
                        const prBody = `Pull request for ${ticketDetails.key}: ${ticketDetails.summary}\n\nJira Ticket: [${ticketDetails.key}](${jiraTicketUrl})`; // Add Jira ticket URL to PR body
                        const prUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls`;

                        console.log(`Creating pull request with payload:`);
                        console.log(`Title: ${prTitle}`);
                        console.log(`Head: ${trimmedBranchName}`);
                        console.log(`Base: master`);

                        const prResponse = await axios.post(
                            prUrl,
                            {
                                title: prTitle,
                                head: trimmedBranchName, // Branch name
                                base: "master",
                                body: prBody,
                            },
                            {
                                headers: {
                                    Authorization: `Bearer ${githubToken}`,
                                    Accept: "application/vnd.github.v3+json",
                                },
                            }
                        );

                        const pullRequestUrl = prResponse.data.html_url;
                        vscode.window.showInformationMessage(`Pull Request created: ${pullRequestUrl}`);

                        // Step 4: Update the PR URL in Jira's custom field `Git link 1`
                        const updateJiraFieldUrl = `${jiraConfig.jiraDomain}/rest/api/2/issue/${ticketDetails.key}`;
                        await axios.put(
                            updateJiraFieldUrl,
                            {
                                fields: {
                                    "customfield_12000": pullRequestUrl, // Replace '12000' with the ID of the custom field
                                },
                            },
                            {
                                auth: {
                                    username: jiraConfig.jiraUsername,
                                    password: jiraConfig.jiraApiToken,
                                },
                            }
                        );

                        vscode.window.showInformationMessage(`PR URL saved to Jira in field "Git link 1".`);

                    } catch (error) {
                        if (axios.isAxiosError(error) && error.response) {
                            console.error("GitHub API response data:", error.response.data);
                            vscode.window.showErrorMessage(`GitHub API error: ${error.response.data.message}`);
                        } else {
                            vscode.window.showErrorMessage("Failed to create pull request or update Jira.");
                            console.error("Error creating pull request or updating Jira:", error);
                        }
                    }
                });
            });
        });
    }


    private async createBuild() {
        vscode.window.showInformationMessage("Build initiated.");
    }



    private async checkGitBranch(ticket: string): Promise<boolean> {
        return new Promise((resolve) => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
            exec('git rev-parse --abbrev-ref HEAD', { cwd: workspacePath }, (error, stdout) => {
                if (error) {
                    console.error('Error checking Git branch:', error);
                    resolve(false);
                    return;
                }
                const currentBranch = stdout.trim();
                resolve(currentBranch === ticket);
            });
        });
    }

    private async getJiraConfig() {
        const config = vscode.workspace.getConfiguration('sugarPlugin');
        const jiraDomain = config.get<string>('jiraDomain') ?? '';
        const jiraUsername = config.get<string>('jiraUsername') ?? '';
        const jiraApiToken = await this.context.secrets.get('jiraApiToken') ?? '';

        if (!jiraApiToken) {
            vscode.window.showErrorMessage('Jira API token is not set. Run "Sugar Plugin: Set API Token" from the command palette.');
        }

        return { jiraDomain, jiraUsername, jiraApiToken };
    }

    private async searchJiraTicket(ticketKey: string) {
        const { jiraDomain, jiraUsername, jiraApiToken } = await this.getJiraConfig();
        const url = `${jiraDomain}/rest/api/2/issue/${ticketKey}?fields=summary,description,status`;

        try {
            const response = await axios.get(url, {
                auth: { username: jiraUsername, password: jiraApiToken }
            });

            const issue: Issue = response.data;
            return {
                key: issue.key,
                summary: issue.fields.summary,
                description: issue.fields.description,
                status: issue.fields.status.name
            };
        } catch (error) {
            vscode.window.showErrorMessage(`Ticket ${ticketKey} not found.`);
            return null;
        }
    }
    private async getAccountIdByEmail(email: string): Promise<string | null> {
        const { jiraDomain, jiraApiToken } = await this.getJiraConfig();
        const url = `${jiraDomain}/rest/api/2/user/search?query=${encodeURIComponent(email)}`;

        console.log(`Fetching account ID for email: ${email}`);
        console.log(`Constructed URL: ${url}`);

        try {
            const response = await axios.get(url, {
                auth: { username: email, password: jiraApiToken }
            });

            if (response.data.length > 0) {
                console.log(`Found account ID: ${response.data[0].accountId}`);
                return response.data[0].accountId;
            } else {
                vscode.window.showErrorMessage(`No user found with email ${email}`);
                return null;
            }
        } catch (error) {
            vscode.window.showErrorMessage('Failed to fetch account ID for assignment.');
            console.error('Error fetching account ID:', error);
            return null;
        }
    }
    private async startWorkOnTicket(ticket: string, summary: string) {
        const { jiraDomain, jiraUsername, jiraApiToken } = await this.getJiraConfig();

        // Step 1: Get account ID for the user
        const accountId = await this.getAccountIdByEmail(jiraUsername);
        if (!accountId) {
            vscode.window.showErrorMessage(`Failed to find account ID for user ${jiraUsername}.`);
            return;
        }

        // Step 2: Assign the ticket using account ID
        const assignUrl = `${jiraDomain}/rest/api/2/issue/${ticket}/assignee`;
        console.log(`Attempting to assign ticket. URL: ${assignUrl}`);
        console.log(`Payload: { accountId: ${accountId} }`);

        try {
            await axios.put(
                assignUrl,
                { accountId },
                { auth: { username: jiraUsername, password: jiraApiToken } }
            );
            vscode.window.showInformationMessage(`Assigned ticket ${ticket} to ${jiraUsername}.`);
        } catch (error) {
            console.error('Error assigning ticket:', error);
            vscode.window.showErrorMessage(`Failed to assign ticket ${ticket} to yourself.`);
            return;
        }

        // Step 3: Transition the ticket to "In Progress"
        const transitionUrl = `${jiraDomain}/rest/api/2/issue/${ticket}/transitions`;
        const transitionId = "4"; // Assuming "4" is the correct ID for "Start Progress"

        try {
            await axios.post(
                transitionUrl,
                { transition: { id: transitionId } },
                { auth: { username: jiraUsername, password: jiraApiToken } }
            );
            vscode.window.showInformationMessage(`Ticket ${ticket} transitioned to "In Progress".`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to transition ticket ${ticket} to "In Progress".`);
            console.error('Error transitioning ticket:', error);
            return;
        }

        // Step 4: Create Git branch
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        const branchName = ticket;
        exec(`git checkout -b ${branchName} --track upstream/master`, { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to create branch ${branchName}: ${stderr}`);
                return;
            }
            vscode.window.showInformationMessage(`Created branch ${branchName} tracking upstream/master`);
        });
    }

    private getHtmlForWebview(jiraDomain: string) {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        padding: 15px;
                        color: #333;
                    }
                    h2, h3 {
                        color: #0052cc;
                        margin-bottom: 5px;
                    }
                    #ticketInput {
                        width: 100%;
                        padding: 6px;
                        margin-bottom: 8px;
                        border: 1px solid #ccc;
                        border-radius: 3px;
                        font-size: 13px;
                    }
                    #ticketDetails, #inProgress, #changedFilesContainer, #gitLinkContainer, #dockerContainer {
                        margin-top: 12px;
                        padding: 8px;
                        background-color: #f9f9f9;
                        border: 1px solid #e1e4e8;
                        border-radius: 4px;
                    }
                    #changedFilesContainer {
                        max-height: 200px; /* Set max height */
                        overflow-y: auto; /* Enable vertical scrolling */
                    }
                    .button-container, .changed-file-actions {
                        display: flex;
                        gap: 6px;
                        margin-top: 8px;
                    }
                    button {
                        padding: 4px 8px;
                        font-size: 12px;
                        border: none;
                        border-radius: 3px;
                        cursor: pointer;
                        transition: background-color 0.3s ease;
                    }
                    button:hover {
                        background-color: #0052cc;
                        color: #fff;
                    }
                    button.search-button {
                        background-color: #007bff;
                        color: white;
                    }
                    button.pr-button, button.build-button, button.docker-button {
                        background-color: #28a745;
                        color: white;
                    }
                    .changed-file {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 4px 0;
                        font-size: 12px;
                        border-bottom: 1px solid #ddd;
                    }
                    .changed-file.staged {
                        color: #28a745; /* Green for staged files */
                    }
                    .changed-file.unstaged {
                        color: #d9534f; /* Red for unstaged files */
                    }
                    .changed-file-actions button {
                        padding: 4px;
                        font-size: 12px;
                        color: white;
                        border-radius: 3px;
                        border: none;
                        cursor: pointer;
                        transition: background-color 0.3s ease;
                    }
                    .stage-button {
                        background-color: #5cb85c; /* Green for staging */
                    }
                    .stage-button:hover {
                        background-color: #4cae4c;
                    }
                    .unstage-button {
                        background-color: #f0ad4e; /* Orange for unstaging */
                    }
                    .unstage-button:hover {
                        background-color: #ec971f;
                    }
                </style>
            </head>
            <body>
                <h2>Jira Ticket Management</h2>
                <input type="text" id="ticketInput" placeholder="Enter ticket ID" />
                <button class="search-button" onclick="searchTicket()">Search</button>
                <div id="ticketDetails"></div>
                <div id="inProgress"></div>
                <div id="gitLinkContainer"></div> <!-- Container for Git Link 1 -->
    
                <h3>Changed Files</h3>
                <div id="changedFilesContainer">
                    <ul id="changedFiles" style="list-style-type: none; padding: 0; margin: 0;"></ul>
                </div>
    
                <h3>Docker Management</h3>
                <div id="dockerContainer">
                    <button class="docker-button" onclick="buildDockerImage()">Build Image</button>
                    <button class="docker-button" onclick="runDockerContainer()">Run Container</button>
                </div>
    
                <script>
                    const vscode = acquireVsCodeApi();
    
                    function searchTicket() {
                        const ticket = document.getElementById('ticketInput').value;
                        vscode.postMessage({ command: 'searchJira', ticket });
                    }
    
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'displayTicketDetails') {
                            displayTicketDetails(message.ticketDetails);
                        } else if (message.command === 'workStarted') {
                            document.getElementById('ticketDetails').innerText = message.message;
                        } else if (message.command === 'displayInProgress') {
                            displayInProgress(message.message, message.displayButtons, message.gitLink);
                        } else if (message.command === 'displayChangedFiles') {
                            displayChangedFiles(message.changedFiles);
                        }
                    });
    
                   function displayTicketDetails(ticket, jiraDomain) {
                        const detailsDiv = document.getElementById('ticketDetails');
                        if (!ticket) {
                            detailsDiv.innerHTML = '<p>Ticket not found.</p>';
                        } else {
                            const ticketUrl = jiraDomain + '/browse/' + ticket.key;
                            const encodedSummary = encodeURIComponent(ticket.summary);

                            detailsDiv.innerHTML = 
                                '<p><strong>Ticket:</strong> ' + ticket.key + '</p>' +
                                '<p><strong>Summary:</strong> <a href="' + ticketUrl + '" target="_blank">' + ticket.summary + '</a></p>' +
                                '<p><strong>Status:</strong> ' + ticket.status + '</p>' +
                                (ticket.status === 'Open' ? 
                                    '<button onclick="startWorkOnTicket(&quot;' + ticket.key + '&quot;, &quot;' + encodedSummary + '&quot;)">Start Work</button>' 
                                    : '') +
                                (ticket.status === 'In Progress' ? 
                                    '<div class="button-container">' +
                                        '<button class="pr-button" onclick="createPR()">Create PR</button> ' +
                                        '<button class="build-button" onclick="createBuild()">Create Build</button>' +
                                    '</div>'
                                    : '');
                        }
                    }

    
                    function displayInProgress(message, displayButtons, gitLink) {
                        const inProgressDiv = document.getElementById('inProgress');
                        inProgressDiv.innerText = message;
    
                        // Display Git Link 1 if available
                        const gitLinkContainer = document.getElementById('gitLinkContainer');
                        if (gitLink) {
                            gitLinkContainer.innerHTML = \`<p><strong>Git Link 1:</strong> <a href="\${gitLink}" target="_blank">\${gitLink}</a></p>\`;
                        } else {
                            gitLinkContainer.innerHTML = '';
                        }
    
                        // Display buttons if applicable
                        if (displayButtons) {
                            const buttonsHtml = gitLink
                                ? '<button class="build-button" onclick="createBuild()">Create Build</button>'
                                : '<button class="pr-button" onclick="createPR()">Create PR</button> <button class="build-button" onclick="createBuild()">Create Build</button>';
                            inProgressDiv.innerHTML += \`<div class="button-container">\${buttonsHtml}</div>\`;
                        }
                    }
    
                    function displayChangedFiles(files) {
                        const changedFilesList = document.getElementById('changedFiles');
                        changedFilesList.innerHTML = '';
    
                        function getShortPath(filePath) {
                            return filePath.split('/').pop(); // Extract only the file name
                        }
    
                        files.staged.forEach(file => {
                            changedFilesList.innerHTML += \`
                                <li class="changed-file staged">
                                    <span title="\${file}" onclick="viewChanges('\${file}')">\${getShortPath(file)}</span>
                                    <div class="changed-file-actions">
                                        <button class="unstage-button" title="Unstage file" onclick="unstageFile('\${file}')">🗙</button>
                                    </div>
                                </li>\`;
                        });
    
                        files.unstaged.forEach(file => {
                            changedFilesList.innerHTML += \`
                                <li class="changed-file unstaged">
                                    <span title="\${file}" onclick="viewChanges('\${file}')">\${getShortPath(file)}</span>
                                    <div class="changed-file-actions">
                                        <button class="stage-button" title="Stage file" onclick="stageFile('\${file}')">+</button>
                                    </div>
                                </li>\`;
                        });
                    }
    
                    function startWorkOnTicket(ticket, encodedSummary) {
                        const summary = decodeURIComponent(encodedSummary);
                        vscode.postMessage({ command: 'startWork', ticket, summary });
                    }
    
                    function createPR() {
                        vscode.postMessage({ command: 'createPR' });
                    }
    
                    function createBuild() {
                        vscode.postMessage({ command: 'createBuild' });
                    }
    
                    function stageFile(file) {
                        vscode.postMessage({ command: 'stageFile', file });
                    }
    
                    function unstageFile(file) {
                        vscode.postMessage({ command: 'unstageFile', file });
                    }
    
                    function viewChanges(file) {
                        vscode.postMessage({ command: 'viewChanges', file });
                    }
    
                    // Docker functions
                    function buildDockerImage() {
                        vscode.postMessage({ command: 'buildDockerImage' });
                    }
    
                    function runDockerContainer() {
                        vscode.postMessage({ command: 'runDockerContainer' });
                    }
                </script>
            </body>
            </html>`;
    }


}

export function deactivate() { }
