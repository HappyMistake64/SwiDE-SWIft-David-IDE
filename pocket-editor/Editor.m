#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

@interface PocketEditor : UIViewController <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) WKWebView *browser;
@property(nonatomic, strong) NSURL *editorURL;
@end

@implementation PocketEditor

- (void)showError:(NSString *)message {
    if (self.presentedViewController) return;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe"
        message:message preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.systemBackgroundColor;
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    [configuration.userContentController addScriptMessageHandler:self name:@"exportProject"];
    [configuration.userContentController addScriptMessageHandler:self name:@"exportWorkspaceZip"];
    self.browser = [[WKWebView alloc] initWithFrame:CGRectZero configuration:configuration];
    self.browser.navigationDelegate = self;
    self.browser.UIDelegate = self;
    self.browser.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.browser];
    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.browser.topAnchor constraintEqualToAnchor:guide.topAnchor],
        [self.browser.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],
        [self.browser.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [self.browser.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor]
    ]];
    self.editorURL = [NSBundle.mainBundle URLForResource:@"index" withExtension:@"html"];
    if (self.editorURL) {
        [self.browser loadFileURL:self.editorURL allowingReadAccessToURL:self.editorURL];
    } else {
        [self.browser loadHTMLString:@"<p>Soubor editoru index.html chybí.</p>" baseURL:nil];
    }
}

- (BOOL)isEditorURL:(NSURL *)url {
    return url.isFileURL && self.editorURL &&
        [url.URLByStandardizingPath.path isEqualToString:self.editorURL.URLByStandardizingPath.path];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
 decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if (action.targetFrame.isMainFrame && ([self isEditorURL:url] ||
        (!self.editorURL && [url.absoluteString isEqualToString:@"about:blank"]))) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    BOOL openExternal = action.sourceFrame.isMainFrame && (!action.targetFrame || action.targetFrame.isMainFrame) &&
        action.navigationType == WKNavigationTypeLinkActivated &&
        [url.scheme.lowercaseString isEqualToString:@"https"] && url.host.length;
    decisionHandler(WKNavigationActionPolicyCancel);
    if (openExternal) [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
 initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    if (!frame.isMainFrame || ![self isEditorURL:frame.request.URL] || self.presentedViewController) {
        completionHandler();
        return;
    }
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe" message:message
        preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *action) { completionHandler(); }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
 initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    if (!frame.isMainFrame || ![self isEditorURL:frame.request.URL] || self.presentedViewController) {
        completionHandler(NO);
        return;
    }
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe" message:message
        preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Zrušit" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *action) { completionHandler(NO); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Potvrdit" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *action) { completionHandler(YES); }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
 defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame
 completionHandler:(void (^)(NSString *))completionHandler {
    if (!frame.isMainFrame || ![self isEditorURL:frame.request.URL] || self.presentedViewController) {
        completionHandler(nil);
        return;
    }
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe" message:prompt
        preferredStyle:UIAlertControllerStyleAlert];
    [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.text = defaultText;
        field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
    }];
    UITextField *field = alert.textFields.firstObject;
    [alert addAction:[UIAlertAction actionWithTitle:@"Zrušit" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *action) { completionHandler(nil); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *action) { completionHandler(field.text); }]];
    [self presentViewController:alert animated:YES completion:nil];
}

// WKWebView presents the system file picker for the editor's HTML file inputs on iOS.
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.isMainFrame || ![self isEditorURL:message.frameInfo.request.URL] ||
        self.presentedViewController) return;

    NSData *data = nil;
    NSString *filename = nil;
    if ([message.name isEqualToString:@"exportProject"]) {
        if (![message.body isKindOfClass:NSString.class]) return;
        data = [(NSString *)message.body dataUsingEncoding:NSUTF8StringEncoding];
        if (!data.length || data.length > 4000000 ||
            ![[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] isKindOfClass:NSDictionary.class]) {
            [self showError:@"Export vyžaduje platný JSON projektu do velikosti 4 MB."];
            return;
        }
        filename = @"swide-project.json";
    } else if ([message.name isEqualToString:@"exportWorkspaceZip"]) {
        if (![message.body isKindOfClass:NSDictionary.class]) return;
        NSDictionary *payload = message.body;
        filename = payload[@"name"];
        NSString *encoded = payload[@"base64"];
        NSUInteger maxBytes = 32 * 1024 * 1024;
        if (![filename isKindOfClass:NSString.class] || !filename.length || filename.length > 128 ||
            ![filename isEqualToString:filename.lastPathComponent] || [filename hasPrefix:@"."] ||
            [filename containsString:@"\\"] || ![filename.pathExtension.lowercaseString isEqualToString:@"zip"] ||
            [filename rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound ||
            ![encoded isKindOfClass:NSString.class] || !encoded.length || encoded.length > ((maxBytes + 2) / 3) * 4) {
            [self showError:@"Export ZIP vyžaduje platný název a archiv do velikosti 32 MiB."];
            return;
        }
        data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
        // The web exporter emits standard ZIP local headers (or an empty ZIP end record).
        const unsigned char *bytes = data.bytes;
        if (data.length < 22 || data.length > maxBytes || bytes[0] != 'P' || bytes[1] != 'K' ||
            !((bytes[2] == 3 && bytes[3] == 4) || (bytes[2] == 5 && bytes[3] == 6))) {
            [self showError:@"Archiv ZIP se nepodařilo načíst."];
            return;
        }
    } else {
        return;
    }
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *directory = [manager.temporaryDirectory URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    NSURL *file = [directory URLByAppendingPathComponent:filename];
    NSError *error = nil;
    if (![manager createDirectoryAtURL:directory withIntermediateDirectories:NO attributes:nil error:&error] ||
        ![data writeToURL:file options:NSDataWritingAtomic error:&error]) {
        [manager removeItemAtURL:directory error:NULL];
        [self showError:error.localizedDescription ?: @"Soubor se nepodařilo uložit."];
        return;
    }
    UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[file] applicationActivities:nil];
    sheet.popoverPresentationController.sourceView = self.view;
    sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1);
    sheet.completionWithItemsHandler = ^(UIActivityType activity, BOOL completed, NSArray *items, NSError *activityError) {
        [manager removeItemAtURL:directory error:NULL];
    };
    [self presentViewController:sheet animated:YES completion:nil];
}

@end

@interface PocketApplication : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation PocketApplication
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [[PocketEditor alloc] init];
    [self.window makeKeyAndVisible];
    return YES;
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(PocketApplication.class));
    }
}
