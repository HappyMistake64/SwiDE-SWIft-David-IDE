#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

@interface PocketEditor : UIViewController <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) WKWebView *browser;
@property(nonatomic, strong) NSURL *editorURL;
@end

@implementation PocketEditor

- (void)showError:(NSString *)message {
    if (self.presentedViewController) return;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Xcode Pocket"
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
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Xcode Pocket" message:message
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
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Xcode Pocket" message:message
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
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Xcode Pocket" message:prompt
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
    if (![message.name isEqualToString:@"exportProject"] || !message.frameInfo.isMainFrame ||
        ![self isEditorURL:message.frameInfo.request.URL] || self.presentedViewController) return;
    if (![message.body isKindOfClass:NSString.class]) return;
    NSData *data = [(NSString *)message.body dataUsingEncoding:NSUTF8StringEncoding];
    if (!data.length || data.length > 4000000 ||
        ![[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] isKindOfClass:NSDictionary.class]) {
        [self showError:@"Export vyžaduje platný JSON projektu do velikosti 4 MB."];
        return;
    }
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *directory = [manager.temporaryDirectory URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    NSURL *file = [directory URLByAppendingPathComponent:@"xcode-pocket-project.json"];
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
