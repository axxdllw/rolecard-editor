import { BookmarkPlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { TagInput } from '@/components/TagInput'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { uuid } from '@/core/util/id'
import { useSettings } from '@/lib/settings'
import { setCardPath, useCardDoc, useCardPath } from './cardDoc'
import { ExtensionsSection } from './ExtensionsSection'
import { FieldLabel, InputField, Section, TextField } from './fields'
import { GreetingsSection } from './GreetingsSection'

const TOC = [
  { id: 'basic', label: '基本信息' },
  { id: 'persona', label: '角色设定' },
  { id: 'greetings', label: '开场白' },
  { id: 'examples', label: '示例对话' },
  { id: 'prompts', label: '提示词覆盖' },
  { id: 'extensions', label: 'ST 扩展' },
  { id: 'meta', label: '元数据' },
]

const EMPTY: string[] = []

/** 把当前描述存成自己的模板，新建卡时可以选 */
function SaveTemplateButton() {
  const description = useCardPath<string>(['data', 'description'], '')
  const [label, setLabel] = useState('')
  const [open, setOpen] = useState(false)
  const save = () => {
    const name = label.trim() || '我的模板'
    const { customTemplates, set } = useSettings.getState()
    set({ customTemplates: [...customTemplates, { id: uuid(), label: name, content: description }] })
    toast.success(`已保存模板「${name}」，新建卡时可以选择`)
    setLabel('')
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" disabled={!description.trim()}>
          <BookmarkPlusIcon /> 存为模板
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-2 p-3" align="end">
        <span className="text-sm">把当前描述保存为新建卡的模板</span>
        <Input
          autoFocus
          placeholder="模板名字"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && save()}
        />
        <Button size="sm" onClick={save}>
          保存
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function TagsField({ path, label, hint, placeholder }: { path: string[]; label: string; hint: string; placeholder: string }) {
  const value = useCardPath<string[]>(path, EMPTY)
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={label} hint={hint} />
      <TagInput value={Array.isArray(value) ? value : EMPTY} onChange={(v) => setCardPath(path, v, `修改${label}`)} placeholder={placeholder} />
    </div>
  )
}

function MetaInfo() {
  const creation = useCardDoc((s) => s.doc?.card.data.creation_date)
  const modification = useCardDoc((s) => s.doc?.card.data.modification_date)
  const createDate = useCardDoc((s) => s.doc?.card.create_date)
  const fmt = (v: unknown) => (typeof v === 'number' ? new Date(v * 1000).toLocaleString() : typeof v === 'string' ? v : '—')
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
      <dt className="text-muted-foreground">创建时间（V3）</dt>
      <dd>{fmt(creation)}</dd>
      <dt className="text-muted-foreground">修改时间（V3）</dt>
      <dd>{fmt(modification)}</dd>
      <dt className="text-muted-foreground">ST 创建时间</dt>
      <dd>{fmt(createDate)}</dd>
    </dl>
  )
}

export function CharacterTab({ avatar }: { avatar: Blob | null }) {
  return (
    <div className="flex gap-6">
      <nav className="sticky top-28 hidden h-fit w-32 shrink-0 flex-col gap-1 text-sm lg:flex">
        {TOC.map((item) => (
          <a key={item.id} href={`#${item.id}`} onClick={(e) => {
            e.preventDefault()
            document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' })
          }} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            {item.label}
          </a>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <Section id="basic" title="基本信息">
          <div className="grid gap-4 sm:grid-cols-2">
            <InputField path={['data', 'name']} label="角色名" hint="name：{{char}} 宏会替换成这个名字" />
            <InputField path={['data', 'nickname']} label="昵称" hint="nickname（V3）：设置后 {{char}} 会优先用昵称，ST 目前不读这个字段" />
            <InputField path={['data', 'creator']} label="作者" hint="creator：卡片作者" />
            <InputField path={['data', 'character_version']} label="版本" hint="character_version：卡片版本号" />
          </div>
          <TagsField path={['data', 'tags']} label="卡片标签" hint="tags：写进卡里的标签，ST 里可以按标签筛选" placeholder="回车或逗号分隔" />
          <TextField
            path={['data', 'creator_notes']}
            label="创作者备注"
            hint="creator_notes：给使用者看的说明，不会发给模型"
            minHeight={60}
          />
        </Section>

        <Section id="persona" title="角色设定" description="这三项每轮都会发给模型，是角色的核心。">
          <TextField
            path={['data', 'description']}
            label="角色描述"
            hint="description：外貌、性格、背景、与用户的关系等，插在提示词的角色定义位置"
            minHeight={200}
            maxHeight={640}
            actions={<SaveTemplateButton />}
          />
          <TextField path={['data', 'personality']} label="性格摘要" hint="personality：简短的性格概括，很多卡留空，写进描述里" minHeight={60} />
          <TextField path={['data', 'scenario']} label="场景" hint="scenario：对话发生的情境" minHeight={60} />
        </Section>

        <GreetingsSection avatar={avatar} />

        <Section id="examples" title="示例对话" description="给模型看的说话风格示例，用 <START> 分隔多段。">
          <TextField
            path={['data', 'mes_example']}
            label="示例对话"
            hint="mes_example：放在提示词顶部，上下文紧张时可能被挤出。也有作者把示例放进世界书的常驻条目里。"
            placeholder={'<START>\n{{user}}: 你好\n{{char}}: ……'}
            minHeight={100}
          />
        </Section>

        <Section id="prompts" title="提示词覆盖" description="只有在 ST 里开启“优先使用角色卡里的提示词”时才生效。">
          <TextField path={['data', 'system_prompt']} label="系统提示词" hint="system_prompt：替换主提示词，可用 {{original}} 引用原本的主提示词" minHeight={60} />
          <TextField
            path={['data', 'post_history_instructions']}
            label="历史后指令"
            hint="post_history_instructions：放在聊天记录之后，离回复最近，约束力最强"
            minHeight={60}
          />
        </Section>

        <ExtensionsSection />

        <Section id="meta" title="元数据">
          <TagsField path={['data', 'source']} label="来源" hint="source（V3）：卡片出处，例如发布页链接" placeholder="回车添加链接或来源 ID" />
          <MetaInfo />
        </Section>
      </div>
    </div>
  )
}
