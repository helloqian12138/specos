App: Todo Manager

Goal:
  Manage personal todos with a clear list page and a quick create flow.

---

Entity Todo:
  id: string (primary)
  title: string (required, maxLength=100)
  completed: boolean (default=false)

---

Action CreateTodo:
  Input:
    title

  Do:
    insert Todo:
      title = input.title
      completed = false

  Return:
    success
    id

---

Action SearchTodos:
  Input:
    searchKey = "" (optional)
    page
    pageSize

  Do:
    query Todo:
      where completed = false
      and title contains searchKey

    paginate by page, pageSize

  Return:
    data: Todo[]
    total

---

Action CompleteTodo:
  Input:
    id

  Do:
    update Todo:
      where id = input.id
      set completed = true

  Return:
    success

---

Page TodoPage (/todos):
  Summary:
    List open todos, search them, and complete them.

  State:
    searchKey = ""
    page = 1
    pageSize = 10

  Load:
    todos = SearchTodos(searchKey, page, pageSize)

  Layout:
    Header:
      text("Todo Manager", align=center)
    
    Content:
      Left (50%):
        input(name: searchInput, value:searchKey)
        button("Search"):
          onClick:
            dispatch SearchTodos(searchInput.value, page, pageSize)
            refresh todos
      Space (50% - 64px)
      Right (64px):
        button("Add Todo", primary):
          onClick:
            openModal CreateTodoModal

    Content:
      table(todos):
        columns:
          id
          title
          action:
            button("Complete"):
              onClick:
                dispatch CompleteTodo(id = row.id)
                refresh todos
        empty: text("No open todos", align=center)

---

Component CreateTodoModal:
  modal("Create Todo"):
    form:
      field title (input, required)

    onSubmit:
      dispatch CreateTodo(title = form.title)
      refresh todos
      closeModal
