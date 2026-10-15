import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'platform_store.dart';
import 'timetable.dart';
import 'app_theme.dart';
import 'course_editor.dart';
import 'course_details.dart';
import 'schedule_components.dart';

void main() => runApp(const BcornApp());

class BcornApp extends StatelessWidget {
  const BcornApp({super.key, this.store});
  final PlatformStore? store;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '今日课表 · bcorn',
    debugShowCheckedModeBanner: false,
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: teal,
        surface: paper,
        brightness: Brightness.light,
      ),
      scaffoldBackgroundColor: paper,
      appBarTheme: const AppBarTheme(
        backgroundColor: paper,
        foregroundColor: ink,
        elevation: 0,
        centerTitle: false,
      ),
      textTheme: ThemeData.light().textTheme.apply(
        bodyColor: ink,
        displayColor: ink,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: Color(0xffdedfd8)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: Color(0xffdedfd8)),
        ),
      ),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
      ),
    ),
    home: HomeScreen(store: store ?? PlatformStore()),
  );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.store});
  final PlatformStore store;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  Timetable table = Timetable.empty();
  DateTime now = DateTime.now();
  late DateTime selected = dateOnly(now);
  bool loading = true, saving = false;
  String? loadError;
  int tab = 0;
  Timer? timer;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.store.onCourseLinkAvailable(_consumeCourseLink);
    _load();
    timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() => now = DateTime.now());
    });
  }

  @override
  void dispose() {
    widget.store.onCourseLinkAvailable(null);
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      setState(() => now = DateTime.now());
      _consumeCourseLink();
    }
  }

  Future<void> _load() async {
    try {
      final loaded = await widget.store.load();
      if (mounted)
        setState(() {
          table = loaded;
          loading = false;
          loadError = null;
        });
      if (mounted) await _consumeCourseLink();
    } catch (_) {
      if (mounted)
        setState(() {
          loading = false;
          loadError = '课表暂时无法读取。原有数据未修改，请重试。';
        });
    }
  }

  void message(String value) {
    if (mounted)
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(value)));
  }

  Future<bool> _save(Timetable updated) async {
    if (saving || loadError != null) return false;
    setState(() => saving = true);
    try {
      await widget.store.save(updated);
      if (!mounted) return false;
      setState(() => table = updated);
      return true;
    } catch (_) {
      message('保存失败，请重试。你的修改没有覆盖原课表。');
      return false;
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> _edit([Course? course]) async {
    if (saving || loadError != null) return;
    if (course == null && table.courses.length >= 500) {
      message('最多支持 500 门课程，请先删除不需要的课程');
      return;
    }
    final edited = await Navigator.of(context).push<Course>(
      MaterialPageRoute(
        builder: (_) => CourseEditor(
          course: course,
          weekday: selected.weekday,
          onDelete: course == null ? null : () => _delete(course),
        ),
      ),
    );
    if (edited == null || !mounted) return;
    if (await _save(table.upsert(edited))) message('已保存，桌面组件已请求刷新');
  }

  Future<bool> _delete(Course course) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除这门课？'),
        content: Text('“${course.title}”会从课表和桌面组件中移除。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (yes == true && mounted) return _save(table.remove(course.id));
    return false;
  }

  bool showingDetail = false;
  Future<void> _consumeCourseLink() async {
    if (loading || loadError != null || !mounted || showingDetail) return;
    final id = await widget.store.takePendingCourseId();
    if (id == null || !mounted) return;
    final matches = table.courses.where((course) => course.id == id);
    if (matches.isEmpty) {
      message('这门课程已删除，请查看当前课表');
      return;
    }
    await _showCourse(matches.first);
  }

  Future<void> _showCourse(Course course) async {
    if (!mounted || showingDetail) return;
    showingDetail = true;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: paper,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * .92,
      ),
      builder: (ctx) => CourseDetails(
        course: course,
        onLongPress: () => _showCourseActions(course),
        onEdit: () {
          Navigator.pop(ctx);
          _edit(course);
        },
      ),
    );
    showingDetail = false;
    if (mounted) _consumeCourseLink();
  }

  Future<void> _showCourseActions(Course course) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => CourseActionMenu(
        onNavigate: () {
          Navigator.pop(ctx);
          _chooseNavigation(course);
        },
      ),
    );
  }

  Future<void> _chooseNavigation(Course course) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => NavigationChoices(course: course, onOpen: _openUrl),
    );
  }

  Future<void> _openUrl(String url) async {
    try {
      if (!await widget.store.openUrl(url)) message('无法打开此链接，请检查链接或安装对应地图应用');
    } catch (_) {
      message('无法打开此链接，请检查链接或安装对应地图应用');
    }
  }

  Future<void> _demo() async {
    if (table.courses.isNotEmpty) return;
    if (await _save(Timetable.demo(now))) message('已加入 3 门示例课程，可随时编辑或删除');
  }

  Future<void> _import() async {
    final controller = TextEditingController();
    final raw = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('导入课表 JSON'),
        content: SizedBox(
          width: 500,
          child: TextField(
            controller: controller,
            minLines: 5,
            maxLines: 9,
            decoration: const InputDecoration(hintText: '粘贴之前导出的课表。导入将替换当前课表。'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text),
            child: const Text('读取'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (raw == null || !mounted) return;
    try {
      final imported = Timetable.decode(raw);
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('替换为 ${imported.courses.length} 门课程？'),
          content: const Text('当前课表将被替换。建议先复制备份，导入后无法撤销。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('替换课表'),
            ),
          ],
        ),
      );
      if (confirmed == true && mounted && await _save(imported))
        message('已导入课表');
    } on FormatException catch (e) {
      message(e.message);
    }
  }

  Future<void> _widgetHelp() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '让课表住在桌面',
                style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 16),
              const Text(
                'Android / vivo\n长按桌面空白处 → 添加组件 → 今日课表。放到独立桌面页，再长按组件，拖动边框铺满可用区域。桌面网格、边距和底部栏由系统决定。',
                style: TextStyle(height: 1.65),
              ),
              const SizedBox(height: 16),
              const Text(
                'iPhone\n长按桌面 → 添加小组件 → 今日课表，选择大号。锁屏可添加“下一节”矩形组件，需要 iOS 16 或更新版本。',
                style: TextStyle(height: 1.65),
              ),
              const SizedBox(height: 16),
              const Text(
                '息屏显示由系统与机型决定，不能保证 vivo AOD 显示第三方课表。组件刷新也可能因省电而延迟；打开应用可查看实时状态。',
                style: TextStyle(color: Color(0xff697481), height: 1.6),
              ),
              const SizedBox(height: 22),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () async {
                    Navigator.pop(ctx);
                    try {
                      final requested = await widget.store.requestPinWidget();
                      if (!requested) message('请长按手机桌面，通过“添加组件”选择今日课表');
                    } catch (_) {
                      message('请在手机桌面手动添加组件');
                    }
                  },
                  icon: const Icon(Icons.widgets_outlined),
                  label: const Padding(
                    padding: EdgeInsets.all(12),
                    child: Text('添加到 Android 桌面'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: loading
            ? const Center(child: CircularProgressIndicator())
            : loadError != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.cloud_off_outlined, size: 46),
                      const SizedBox(height: 20),
                      Text(loadError!, textAlign: TextAlign.center),
                      const SizedBox(height: 20),
                      FilledButton(onPressed: _load, child: const Text('重试')),
                    ],
                  ),
                ),
              )
            : AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                child: tab == 2 ? _settings() : _schedule(),
              ),
      ),
      floatingActionButton: tab != 2 && !loading && loadError == null
          ? FloatingActionButton.extended(
              onPressed: saving ? null : () => _edit(),
              backgroundColor: ink,
              foregroundColor: Colors.white,
              icon: const Icon(Icons.add),
              label: const Text('添加课程'),
            )
          : null,
      bottomNavigationBar: NavigationBar(
        backgroundColor: paper,
        selectedIndex: tab,
        onDestinationSelected: (value) => setState(() {
          tab = value;
          if (value == 0) selected = dateOnly(now);
        }),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.view_day_outlined),
            selectedIcon: Icon(Icons.view_day),
            label: '今日',
          ),
          NavigationDestination(
            icon: Icon(Icons.calendar_view_week_outlined),
            selectedIcon: Icon(Icons.calendar_view_week),
            label: '一周',
          ),
          NavigationDestination(
            icon: Icon(Icons.widgets_outlined),
            selectedIcon: Icon(Icons.widgets),
            label: '组件与设置',
          ),
        ],
      ),
    );
  }

  Widget _schedule() {
    final daily = table.onDay(selected);
    final current = table.current(now);
    final next = table.nextToday(now);
    final weekStart = shiftDays(selected, 1 - selected.weekday);
    return ListView(
      key: ValueKey(tab),
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 100),
      children: [
        Row(
          children: [
            const Text(
              'bcorn / 每天，从容一点',
              style: TextStyle(
                color: Color(0xff708078),
                fontSize: 12,
                letterSpacing: 1.5,
              ),
            ),
            const Spacer(),
            if (saving)
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              IconButton(
                tooltip: '添加桌面组件',
                onPressed: _widgetHelp,
                icon: const Icon(Icons.add_to_home_screen, size: 21),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              tab == 0 ? '今日课表' : '这一周',
              style: const TextStyle(
                fontSize: 34,
                height: 1.15,
                fontWeight: FontWeight.w800,
                letterSpacing: -1.2,
              ),
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                '${selected.month} 月 ${selected.day} 日',
                style: const TextStyle(color: Color(0xff788071)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 22),
        if (tab == 0) ...[
          CurrentCourseCard(
            course: current.isNotEmpty ? current.first : next,
            current: current.isNotEmpty,
            simultaneous: current.length,
            onTap: current.isNotEmpty || next != null
                ? () => _showCourse(current.isNotEmpty ? current.first : next!)
                : null,
            onLongPress: current.isNotEmpty || next != null
                ? () => _showCourseActions(
                    current.isNotEmpty ? current.first : next!,
                  )
                : null,
          ),
          const SizedBox(height: 24),
        ],
        if (tab == 1)
          Row(
            children: [
              IconButton(
                tooltip: '上一周',
                onPressed: () =>
                    setState(() => selected = shiftDays(selected, -7)),
                icon: const Icon(Icons.chevron_left),
              ),
              Expanded(
                child: Center(
                  child: Text(
                    '${weekStart.month}/${weekStart.day} — ${shiftDays(weekStart, 6).month}/${shiftDays(weekStart, 6).day}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              TextButton(
                onPressed: () => setState(() => selected = dateOnly(now)),
                child: const Text('本周'),
              ),
              IconButton(
                tooltip: '下一周',
                onPressed: () =>
                    setState(() => selected = shiftDays(selected, 7)),
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
        Row(
          children: List.generate(7, (index) {
            final date = shiftDays(weekStart, index),
                active =
                    dateKey(shiftDays(weekStart, index)) == dateKey(selected);
            final hasCourses = table.onDay(date).isNotEmpty;
            return Expanded(
              child: Semantics(
                label: '${date.month}月${date.day}日 星期${dayLabels[index]}',
                selected: active,
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () => setState(() {
                    selected = date;
                    tab = 1;
                  }),
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 2),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    decoration: BoxDecoration(
                      color: active ? ink : Colors.transparent,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Column(
                      children: [
                        Text(
                          dayLabels[index],
                          style: TextStyle(
                            fontSize: 11,
                            color: active
                                ? Colors.white70
                                : const Color(0xff858a83),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '${date.day}',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: active ? Colors.white : ink,
                          ),
                        ),
                        const SizedBox(height: 7),
                        Container(
                          width: 4,
                          height: 4,
                          decoration: BoxDecoration(
                            color: hasCourses
                                ? active
                                      ? const Color(0xffe2b879)
                                      : teal
                                : Colors.transparent,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
        const SizedBox(height: 26),
        Row(
          children: [
            Text(
              dateKey(selected) == dateKey(now)
                  ? '今天的安排'
                  : '周${dayLabels[selected.weekday - 1]}的安排',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const Spacer(),
            Text(
              '${daily.length} 门课程',
              style: const TextStyle(fontSize: 12, color: Color(0xff858a83)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (daily.isEmpty)
          _empty()
        else
          ...daily.map(
            (c) => CourseCard(
              course: c,
              active: c.currentAt(now) && dateKey(selected) == dateKey(now),
              onTap: () => _showCourse(c),
              onLongPress: () => _showCourseActions(c),
            ),
          ),
        if (daily.isNotEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Center(
              child: Text(
                '点击课程放大查看 · 长按课程打开更多操作',
                style: TextStyle(color: Color(0xff8b9087), fontSize: 11),
              ),
            ),
          ),
      ],
    );
  }

  Widget _empty() => Container(
    padding: const EdgeInsets.all(28),
    decoration: BoxDecoration(
      color: Colors.white,
      border: Border.all(color: const Color(0xffe7e5de)),
      borderRadius: BorderRadius.circular(22),
    ),
    child: Column(
      children: [
        const Icon(Icons.spa_outlined, color: teal, size: 36),
        const SizedBox(height: 16),
        Text(
          table.courses.isEmpty ? '从第一门课开始' : '这一天没有课',
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        const Text(
          '把课程、教室和导航链接放在一起。\n每天抬眼，就知道下一步。',
          textAlign: TextAlign.center,
          style: TextStyle(color: Color(0xff7b847b), fontSize: 13, height: 1.7),
        ),
        const SizedBox(height: 16),
        TextButton(onPressed: () => _edit(), child: const Text('＋ 添加一门课程')),
        if (table.courses.isEmpty)
          TextButton(
            onPressed: saving ? null : _demo,
            child: const Text(
              '先看看示例课表',
              style: TextStyle(color: Color(0xff899188), fontSize: 12),
            ),
          ),
      ],
    ),
  );
  Widget _settings() => ListView(
    key: const ValueKey(2),
    padding: const EdgeInsets.all(24),
    children: [
      const SizedBox(height: 16),
      const Text(
        '你的课表，\n随手可见。',
        style: TextStyle(
          fontSize: 34,
          fontWeight: FontWeight.w800,
          height: 1.3,
        ),
      ),
      const SizedBox(height: 12),
      const Text('本地保存，无需账号。', style: TextStyle(color: Color(0xff7b847b))),
      const SizedBox(height: 30),
      _settingTile(
        Icons.widgets_outlined,
        '添加桌面 / 锁屏组件',
        'Android 可调整大小；iPhone 使用系统尺寸',
        _widgetHelp,
      ),
      _settingTile(
        Icons.copy_outlined,
        '复制课表备份',
        'JSON 格式，可在另一台手机导入',
        () async {
          await Clipboard.setData(
            ClipboardData(text: table.encode(pretty: true)),
          );
          message('课表备份已复制。粘贴分享前请确认其中的地点和备注。');
        },
      ),
      _settingTile(
        Icons.file_download_outlined,
        '从 JSON 导入',
        '预览课程数量并确认后替换当前课表',
        _import,
      ),
      const SizedBox(height: 22),
      Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: const Color(0xffeaece4),
          borderRadius: BorderRadius.circular(20),
        ),
        child: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('关于隐私与刷新', style: TextStyle(fontWeight: FontWeight.w700)),
            SizedBox(height: 10),
            Text(
              '课程保存在本机，组件与应用共享同一份课表。此版本不登录 ACORN、不上传课表。\n\n打开导航链接时，目的地会交给你选择的地图或网页服务。桌面和锁屏组件可能展示课程地点与备注，请按需要调整锁屏隐私。\n\n后台组件受系统刷新与省电策略限制；本应用打开时每 30 秒更新“当前 / 下一节”。',
              style: TextStyle(
                fontSize: 12,
                height: 1.7,
                color: Color(0xff667267),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 24),
      const Text(
        'bcorn mobile · 0.1.0\n独立移动端实验版 / 手动课表',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 11, height: 1.7, color: Color(0xff8c918a)),
      ),
    ],
  );
  Widget _settingTile(
    IconData icon,
    String title,
    String subtitle,
    VoidCallback onTap,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(18),
      child: ListTile(
        onTap: saving ? null : onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        leading: Icon(icon, color: teal),
        title: Text(
          title,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 5),
          child: Text(
            subtitle,
            style: const TextStyle(fontSize: 11, color: Color(0xff879083)),
          ),
        ),
        trailing: const Icon(Icons.chevron_right, size: 18),
      ),
    ),
  );
}
